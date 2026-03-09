// FitBuddy AI Server v1.0.1
import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  let db: Database.Database;
  try {
    db = new Database("fitbuddy.db");
    console.log("Database initialized successfully");
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        age INTEGER,
        weight INTEGER,
        goal TEXT,
        intensity TEXT,
        reminder_time TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        plan_content TEXT,
        nutrition_tip TEXT,
        is_favorite INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS progress_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        weight REAL,
        chest REAL,
        waist REAL,
        hips REAL,
        logged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS workout_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        day_number INTEGER,
        completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS nutrition_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        calories INTEGER,
        protein INTEGER,
        carbs INTEGER,
        fats INTEGER,
        logged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `);
  } catch (err) {
    console.error("Failed to initialize database:", err);
    // Fallback to memory if file fails, or just exit
    process.exit(1);
  }

  app.use(express.json());

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", database: "connected" });
  });

  // API Routes
  app.post("/api/generate", async (req, res) => {
    const { name, age, weight, goal, intensity } = req.body;

    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    
    if (!apiKey || apiKey === "MY_GEMINI_API_KEY" || apiKey.trim() === "") {
      return res.status(500).json({ 
        error: "Gemini API key is missing or is still the placeholder. Please set a valid GEMINI_API_KEY in the AI Studio Secrets panel." 
      });
    }

    if (!apiKey.startsWith("AIza")) {
      return res.status(500).json({ 
        error: "The provided Gemini API key does not appear to be a valid Google API key (it should start with 'AIza'). Please check your Secrets configuration." 
      });
    }

    try {
      const ai = new GoogleGenAI({ apiKey });
      
      // 1. Store User
      const userStmt = db.prepare("INSERT INTO users (name, age, weight, goal, intensity) VALUES (?, ?, ?, ?, ?)");
      const userResult = userStmt.run(name, age, weight, goal, intensity);
      const userId = userResult.lastInsertRowid;

      // 2. Generate AI Content
      const model = "gemini-3-flash-preview";
      
      const planPrompt = `Create a 7-day workout plan for ${name}. 
      Details: Age ${age}, Weight ${weight}kg, Goal: ${goal}, Intensity: ${intensity}. 
      Format: Day 1 to Day 7. Use Markdown.
      For each exercise, include a brief description of the correct form and a YouTube search link for a video demonstration (e.g., [Watch Form](https://www.youtube.com/results?search_query=exercise+name+form)).`;
      
      const tipPrompt = `Give one concise nutrition or recovery tip for the goal: ${goal}.`;

      const [planResponse, tipResponse] = await Promise.all([
        ai.models.generateContent({ model, contents: planPrompt }),
        ai.models.generateContent({ model, contents: tipPrompt })
      ]);

      const planText = planResponse.text || "Failed to generate plan.";
      const tipText = tipResponse.text || "Failed to generate tip.";

      // 3. Store Plan
      const planStmt = db.prepare("INSERT INTO plans (user_id, plan_content, nutrition_tip) VALUES (?, ?, ?)");
      const planResult = planStmt.run(userId, planText, tipText);
      const planId = planResult.lastInsertRowid;

      res.json({ userId, planId, plan: planText, tip: tipText, isFavorite: false });
    } catch (error) {
      console.error("Error generating plan:", error);
      res.status(500).json({ error: "Failed to generate plan: " + (error instanceof Error ? error.message : String(error)) });
    }
  });

  app.post("/api/feedback", async (req, res) => {
    const { userId, feedback } = req.body;

    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (!apiKey || apiKey === "MY_GEMINI_API_KEY" || apiKey.trim() === "" || !apiKey.startsWith("AIza")) {
      return res.status(500).json({ error: "Gemini API key is missing or invalid." });
    }

    try {
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
      if (!user) return res.status(404).json({ error: "User not found" });

      const ai = new GoogleGenAI({ apiKey });
      const model = "gemini-3-flash-preview";
      const prompt = `Update the 7-day workout plan for ${user.name} (Age ${user.age}, Weight ${user.weight}kg, Goal: ${user.goal}, Intensity: ${user.intensity}) based on this feedback: ${feedback}. 
      Format: Day 1 to Day 7. Use Markdown.
      For each exercise, include a brief description of the correct form and a YouTube search link for a video demonstration (e.g., [Watch Form](https://www.youtube.com/results?search_query=exercise+name+form)).`;

      const response = await ai.models.generateContent({ model, contents: prompt });
      const updatedPlan = response.text || "Failed to update plan.";

      // Update latest plan
      const updateStmt = db.prepare("UPDATE plans SET plan_content = ? WHERE user_id = ? ORDER BY created_at DESC LIMIT 1");
      // Note: better-sqlite3 doesn't support ORDER BY in UPDATE directly in some versions or without specific flags, 
      // so let's get the ID first.
      const latestPlan = db.prepare("SELECT id FROM plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(userId) as any;
      if (latestPlan) {
        db.prepare("UPDATE plans SET plan_content = ? WHERE id = ?").run(updatedPlan, latestPlan.id);
      }

      res.json({ plan: updatedPlan, planId: latestPlan?.id });
    } catch (error) {
      console.error("Error updating plan:", error);
      res.status(500).json({ error: "Failed to update plan" });
    }
  });

  app.get("/api/admin/data", (req, res) => {
    const data = db.prepare(`
      SELECT users.*, plans.plan_content, plans.nutrition_tip, plans.created_at as plan_date
      FROM users
      LEFT JOIN plans ON users.id = plans.user_id
      ORDER BY users.created_at DESC
    `).all();
    res.json(data);
  });

  app.post("/api/progress", (req, res) => {
    const { userId, weight, chest, waist, hips } = req.body;
    try {
      const stmt = db.prepare("INSERT INTO progress_logs (user_id, weight, chest, waist, hips) VALUES (?, ?, ?, ?, ?)");
      stmt.run(userId, weight, chest, waist, hips);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to log progress" });
    }
  });

  app.get("/api/progress/:userId", (req, res) => {
    const { userId } = req.params;
    try {
      const logs = db.prepare("SELECT * FROM progress_logs WHERE user_id = ? ORDER BY logged_at ASC").all(userId);
      res.json(logs);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch progress logs" });
    }
  });

  app.post("/api/workout/log", (req, res) => {
    const { userId, dayNumber } = req.body;
    try {
      // Check if already exists to avoid duplicates
      const existing = db.prepare("SELECT id FROM workout_logs WHERE user_id = ? AND day_number = ?").get(userId, dayNumber);
      if (!existing) {
        const stmt = db.prepare("INSERT INTO workout_logs (user_id, day_number) VALUES (?, ?)");
        stmt.run(userId, dayNumber);
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to log workout" });
    }
  });

  app.delete("/api/workout/log", (req, res) => {
    const { userId, dayNumber } = req.body;
    try {
      const stmt = db.prepare("DELETE FROM workout_logs WHERE user_id = ? AND day_number = ?");
      stmt.run(userId, dayNumber);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to remove workout log" });
    }
  });

  app.get("/api/workout/logs/:userId", (req, res) => {
    const { userId } = req.params;
    try {
      const logs = db.prepare("SELECT * FROM workout_logs WHERE user_id = ?").all(userId);
      res.json(logs);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch workout logs" });
    }
  });

  app.post("/api/settings/reminder", (req, res) => {
    const { userId, reminderTime } = req.body;
    try {
      const stmt = db.prepare("UPDATE users SET reminder_time = ? WHERE id = ?");
      stmt.run(reminderTime, userId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to update reminder settings" });
    }
  });

  app.get("/api/settings/reminder/:userId", (req, res) => {
    const { userId } = req.params;
    try {
      const user = db.prepare("SELECT reminder_time FROM users WHERE id = ?").get(userId) as any;
      res.json({ reminderTime: user?.reminder_time });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch reminder settings" });
    }
  });

  app.post("/api/plans/favorite", (req, res) => {
    const { planId, isFavorite } = req.body;
    try {
      const stmt = db.prepare("UPDATE plans SET is_favorite = ? WHERE id = ?");
      stmt.run(isFavorite ? 1 : 0, planId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to update favorite status" });
    }
  });

  app.get("/api/plans/favorites/:userId", (req, res) => {
    const { userId } = req.params;
    try {
      const plans = db.prepare("SELECT * FROM plans WHERE user_id = ? AND is_favorite = 1 ORDER BY created_at DESC").all(userId);
      res.json(plans);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch favorite plans" });
    }
  });

  app.post("/api/nutrition", (req, res) => {
    const { userId, calories, protein, carbs, fats } = req.body;
    try {
      const stmt = db.prepare("INSERT INTO nutrition_logs (user_id, calories, protein, carbs, fats) VALUES (?, ?, ?, ?, ?)");
      stmt.run(userId, calories, protein, carbs, fats);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to log nutrition" });
    }
  });

  app.get("/api/nutrition/:userId", (req, res) => {
    const { userId } = req.params;
    try {
      const logs = db.prepare("SELECT * FROM nutrition_logs WHERE user_id = ? ORDER BY logged_at ASC").all(userId);
      res.json(logs);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch nutrition logs" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
