require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const puppeteer = require("puppeteer");
const fs = require("fs");
const { exec } = require("child_process");
const stringSimilarity = require("string-similarity");
const natural = require("natural");
const path = require("path");
const vm = require("vm");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Connection Error:", err));

// Schema Definitions
const KnowledgeSchema = new mongoose.Schema({
  topic: { type: String, required: true, index: true },
  content: { type: String, required: true },
  source: { type: String, default: "unknown" },
  confidence: { type: Number, default: 0.7 },
  lastUpdated: { type: Date, default: Date.now },
  accessCount: { type: Number, default: 0 }
});
const Knowledge = mongoose.model("Knowledge", KnowledgeSchema);

const QuerySchema = new mongoose.Schema({
  query: { type: String, required: true },
  keywords: [String],
  responseSuccess: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now }
});
const Query = mongoose.model("Query", QuerySchema);

const CodeUpdateSchema = new mongoose.Schema({
  version: { type: Number, required: true },
  code: { type: String, required: true },
  changes: { type: String },
  performance: { type: Object },
  timestamp: { type: Date, default: Date.now }
});
const CodeUpdate = mongoose.model("CodeUpdate", CodeUpdateSchema);

const restrictedWords = [
  "illegal", "hacking tutorials", "malware", "exploit", "phishing",
  "password cracking", "ddos", "botnet", "ransomware", "keylogger"
];

const safetyCheck = (content) => {
  if (!content) return false;
  return !restrictedWords.some(word => 
    content.toLowerCase().includes(word.toLowerCase())
  );
};

const scrapeData = async (topic) => {
  console.log(`🔍 Scraping data for: ${topic}...`);
  
  const browser = await puppeteer.launch({ 
    headless: "new",
    executablePath: "/opt/render/.cache/puppeteer/chrome/linux-133.0.6943.126/chrome-linux64/chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const page = await browser.newPage();
  
  // Array of tech information sources
  const sources = [
    { url: `https://en.wikipedia.org/wiki/${topic}`, selector: "#mw-content-text p" },
    { url: `https://developer.mozilla.org/en-US/search?q=${topic}`, selector: ".result-list .result p" },
    { url: `https://stackoverflow.com/search?q=${topic}`, selector: ".js-post-summary" },
    { url: `https://dev.to/search?q=${topic}`, selector: ".crayons-story__body" }
  ];
  
  try {
    for (const source of sources) {
      await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/110.0.0.0 Safari/537.36");
      
      // Add random delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
      
      try {
        await page.goto(source.url, { 
          waitUntil: "domcontentloaded", 
          timeout: 30000 
        });
        
        const content = await page.evaluate((selector) => {
          const elements = document.querySelectorAll(selector);
          return Array.from(elements).map(el => el.innerText).join("\n").slice(0, 2000);
        }, source.selector);
        
        if (content) {
          // Store or update the knowledge
          await Knowledge.updateOne(
            { topic, source: source.url }, 
            { 
              $set: { 
                content, 
                source: source.url,
                lastUpdated: new Date() 
              },
              $inc: { confidence: 0.1 }
            },
            { upsert: true }
          );
          console.log(`✅ Saved content for ${topic} from ${source.url}`);
        }
      } catch (sourceError) {
        console.error(`❌ Error with source ${source.url}:`, sourceError.message);
        continue;
      }
    }
  } catch (error) {
    console.error(`❌ Error scraping ${topic}:`, error.message);
  } finally {
    await browser.close();
  }
};

const discoverNewTopics = async () => {
  console.log("🔎 Discovering new technology topics...");
  
  const browser = await puppeteer.launch({ 
    headless: true, 
    args: ["--no-sandbox", "--disable-setuid-sandbox"] 
  });
  const page = await browser.newPage();
  
  const discoveredTopics = new Set();
  
  try {
    // Technology trend sources
    const trendingSources = [
      { url: "https://github.com/trending", selector: ".Box-row" },
      { url: "https://news.ycombinator.com/", selector: ".titleline" },
      { url: "https://techcrunch.com/", selector: "article h2" }
    ];
    
    for (const source of trendingSources) {
      try {
        await page.goto(source.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        
        let topics = [];
        
        if (source.url.includes("github")) {
          topics = await page.evaluate((selector) => {
            const repos = document.querySelectorAll(selector);
            return Array.from(repos).map(repo => {
              const name = repo.querySelector("h2")?.innerText.trim().replace(/\s+/g, "_") || "";
              const description = repo.querySelector("p")?.innerText || "";
              return { name, description };
            });
          }, source.selector);
          
          // Extract technology keywords from GitHub
          for (const repo of topics) {
            const keywords = repo.description
              .split(/\s+/)
              .filter(word => word.length > 3 && /^[a-zA-Z0-9_]+$/.test(word))
              .map(word => word.charAt(0).toUpperCase() + word.slice(1));
            
            keywords.forEach(keyword => discoveredTopics.add(keyword));
            discoveredTopics.add(repo.name);
          }
        } else {
          // Generic approach for other sites
          topics = await page.evaluate((selector) => {
            const elements = document.querySelectorAll(selector);
            return Array.from(elements).map(el => el.innerText.trim());
          }, source.selector);
          
          // Extract keywords from titles
          for (const title of topics) {
            const words = title
              .split(/\s+/)
              .filter(word => word.length > 4 && /^[a-zA-Z0-9]+$/.test(word))
              .map(word => word.charAt(0).toUpperCase() + word.slice(1));
            
            words.forEach(word => discoveredTopics.add(word));
          }
        }
      } catch (sourceError) {
        console.error(`❌ Error with discovery source ${source.url}:`, sourceError.message);
        continue;
      }
    }
    
    // Filter out non-tech topics and add tech-specific keywords
    const techKeywords = ["API", "Framework", "Language", "Protocol", "Algorithm", "Database", 
                          "Cloud", "Server", "Browser", "Network", "Security"];
    
    const filteredTopics = Array.from(discoveredTopics)
      .filter(topic => {
        // Filter out common non-tech words, short words, or overly generic terms
        const nonTechWords = ["the", "and", "this", "that", "what", "when", "why", "how", "who"];
        return !nonTechWords.includes(topic.toLowerCase()) && 
               topic.length > 3 && 
               !/^\d+$/.test(topic);
      });
    
    console.log(`🔍 Discovered ${filteredTopics.length} potential new topics`);
    
    // Learn about new topics (limit to prevent overloading)
    const topicsToLearn = filteredTopics.slice(0, 10);
    for (const topic of topicsToLearn) {
      const exists = await Knowledge.findOne({ topic });
      if (!exists) {
        console.log(`🆕 Learning about new topic: ${topic}`);
        await scrapeData(topic);
      }
    }
  } catch (error) {
    console.error("❌ Error discovering topics:", error.message);
  } finally {
    await browser.close();
  }
};

const improveAI = async () => {
  console.log("🚀 Updating AI knowledge...");
  
  // Core technology topics to always keep updated
  const coreTopics = [
    "Artificial_intelligence", "Machine_learning", "Deep_learning",
    "Cybersecurity", "Blockchain", "Cloud_computing", "Web_development",
    "DevOps", "Data_science", "Internet_of_Things", "Augmented_reality",
    "JavaScript", "Python", "React", "Node.js", "MongoDB", "Express.js"
  ];
  
  // Update core knowledge
  for (const topic of coreTopics) {
    await scrapeData(topic);
  }
  
  // Find and update outdated knowledge (older than 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  const outdatedKnowledge = await Knowledge.find({
    lastUpdated: { $lt: thirtyDaysAgo }
  }).limit(5);
  
  for (const knowledge of outdatedKnowledge) {
    console.log(`🔄 Refreshing outdated knowledge: ${knowledge.topic}`);
    await scrapeData(knowledge.topic);
  }
  
  // Find and update most accessed topics
  const popularTopics = await Knowledge.find()
    .sort({ accessCount: -1 })
    .limit(5);
  
  for (const topic of popularTopics) {
    console.log(`📈 Updating popular topic: ${topic.topic}`);
    await scrapeData(topic.topic);
  }
};

const testNewCode = (newCode) => {
  return new Promise((resolve, reject) => {
    const testFile = "test_code_temp.js"; // Use a temporary file for testing

    try {
      fs.writeFileSync(testFile, newCode);

      exec(`node ${testFile}`, (error, stdout, stderr) => {
        fs.unlinkSync(testFile); // Always remove the test file after execution

        if (error) {
          console.error("❌ New code test failed:", stderr);
          return reject(stderr);
        }

        console.log("✅ New code test successful!");
        resolve(stdout);
      });
    } catch (err) {
      console.error("❌ Error writing test file:", err.message);
      reject(err);
    }
  });
};

const updateCode = async (newCode) => {
  // Get current version number
  const latestVersion = await CodeUpdate.findOne().sort({ version: -1 });
  const newVersion = latestVersion ? latestVersion.version + 1 : 1;
  
  // Validate code integrity
  const requiredComponents = [
    "express", "mongoose.connect", "app.listen", "Knowledge", 
    "scrapeData", "updateCode", "improveAI", "discoverNewTopics"
  ];
  
  const hasRequiredComponents = requiredComponents.every(component => 
    newCode.includes(component)
  );
  
  if (!hasRequiredComponents) {
    console.error("❌ Attempted code update missing critical components");
    return false;
  }
  
  // Create backup of current code
  const timestamp = Date.now();
  const backupPath = path.join(__dirname, `backup_${timestamp}.js`);
  fs.writeFileSync(backupPath, fs.readFileSync(__filename));
  
  try {
    // Test compile the new code
    await testNewCode(newCode);
    vm.runInNewContext(newCode, { require }, { timeout: 5000 });
    
    // Store update in database
    await CodeUpdate.create({
      version: newVersion,
      code: newCode,
      changes: "Self-improvement update",
      performance: { timestamp }
    });
    
    // Write new code
    fs.writeFileSync(__filename, newCode);
    console.log(`✅ AI code updated to version ${newVersion}! Restarting server...`);
    execSync("git add server.js");
    execSync('git commit -m "AI self-improvement update"');
    execSync("git push origin main"); // Change 'main' to your branch name

    console.log("✅ Changes pushed to GitHub!");
    // Restart application
    exec("pm2 restart all", (err, stdout, stderr) => {
      if (err) {
        console.error(`❌ Restart Error: ${stderr}`);
        // Rollback if restart fails
        fs.writeFileSync(__filename, fs.readFileSync(backupPath));
        exec("pm2 restart all");
        return false;
      }
    });
    return true;
  } catch (error) {
    console.error("❌ Invalid code update:", error.message);
    // Keep backup for reference
    return false;
  }
};

const generateCode = async (improvementGoal) => {
  console.log("🤖 Generating code for improvement:", improvementGoal);

  // Simulate code generation (replace with actual model integration)
  const newCode = `
    // Example: New code to improve ${improvementGoal}
    const enhancedFunctionality = () => {
      console.log("This is an improved version of the AI!");
    };
    module.exports = { enhancedFunctionality };
  `;

  return newCode;
};

const analyzePerformance = async () => {
  console.log("🧠 Analyzing AI performance...");

  // Get recent failed queries
  const failedQueries = await Query.find({ responseSuccess: false })
    .sort({ timestamp: -1 })
    .limit(10);

  if (failedQueries.length > 0) {
    console.log(`❗ Found ${failedQueries.length} failed queries to learn from`);

    // Extract keywords from failed queries
    const failedKeywords = failedQueries
      .flatMap(q => q.keywords)
      .filter(keyword => keyword && keyword.length > 3);

    // Count keyword frequency
    const keywordCounts = {};
    for (const keyword of failedKeywords) {
      keywordCounts[keyword] = (keywordCounts[keyword] || 0) + 1;
    }

    // Get top keywords to improve
    const topKeywords = Object.keys(keywordCounts)
      .sort((a, b) => keywordCounts[b] - keywordCounts[a])
      .slice(0, 3);

    return topKeywords;
  }

  return [];
};

const selfImprove = async () => {
  console.log("🤖 Starting self-improvement process...");

  // Analyze performance to identify improvement goals
  const improvementGoals = await analyzePerformance();
  if (improvementGoals.length === 0) {
    console.log("✅ No improvements needed at this time.");
    return;
  }

  // Generate new code for each improvement goal
  for (const goal of improvementGoals) {
    console.log(`🎯 Generating code to improve: ${goal}`);

    const newCode = await generateCode(goal);
    if (!newCode) {
      console.log("❌ Failed to generate new code.");
      continue;
    }

    // Apply the update
    const success = await updateCode(newCode);
    if (success) {
      console.log(`✅ Successfully improved: ${goal}`);
    } else {
      console.log(`❌ Failed to apply update for: ${goal}`);
    }
  }
};

const initializeAI = () => {
  console.log("🧠 Initializing AI self-learning system...");

  // Immediate initial learning
  setTimeout(improveAI, 5000);

  // Schedule regular learning tasks
  setInterval(improveAI, 6 * 60 * 60 * 1000);         // Every 6 hours
  setInterval(discoverNewTopics, 12 * 60 * 60 * 1000); // Every 12 hours

  // Schedule self-improvement (e.g., daily)
  setInterval(selfImprove, 24 * 60 * 60 * 1000); // Every 24 hours

  // Self-analysis and optimization
  setInterval(async () => {
    console.log("🧠 AI Self-Analysis Running...");
    // ... (existing self-analysis code)
  }, 24 * 60 * 60 * 1000); // Daily self-analysis
};

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  initializeAI();
});