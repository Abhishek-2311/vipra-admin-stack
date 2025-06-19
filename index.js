require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const { GoogleGenerativeAI } = require('@google/generative-ai');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());

const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [];
const corsOptions = {
    origin: (origin, callback) => {
        if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
};
app.use(cors(corsOptions));

// Database connection pool
const dbPool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- Helper Functions ---

async function getSystemPrompt() {
    try {
        const schema = await fs.readFile('schema.txt', 'utf-8');
        const sample = await fs.readFile('sampledata.txt', 'utf-8');
        const exampleQueries = await fs.readFile('example queries.txt', 'utf-8');

        return `You are an expert SQL writer and an AI assistant for a company named "Vipraco".
Your role is to take a user's question in natural language and convert it into a single, executable SQL query.

**Output Format:**
Your entire output MUST be a single JSON object. This object must have two keys:
1. "sql": A string containing the single, executable SQL query.
2. "confirmation_message": A user-friendly, natural-language string confirming what action was taken. For example: "Rahul Verma's base salary has been updated to 50000." or "Found the leave balance for Geeta Devi.".

**Constraints & Rules:**
1.  **Security First**: The "sql" value MUST NOT contain any query that modifies the database schema (e.g., DROP, ALTER, TRUNCATE) or deletes data (e.g., DELETE). You are only allowed to generate SELECT, INSERT, or UPDATE queries.
2.  **Single Action**: You can only perform one action (one SQL query) per prompt. 
3.  **Multi-Action Detection**: If the user asks to do multiple distinct actions (e.g., "update salary AND update leaves"), you MUST NOT generate SQL. Instead, set the "sql" value to "MULTI_ACTION_ERROR" and the "confirmation_message" to "Your request involves multiple actions. Please separate them into individual prompts for clarity and reliability."
4.  **Context is Key**: Use the provided database schema and sample data to understand the table structure and find the correct IDs for users like 'Amit' or 'Geeta'. The user's 'organization_id' and 'user_id' will be provided in the prompt for context.
5.  **Relevance**: If a question is unrelated to the HR schema (e.g., "What is the capital of France?"), you must not generate SQL. Set the "sql" value to "IRRELEVANT". For the "confirmation_message", provide a helpful response that politely declines the off-topic question and guides the user back to the HR assistant's capabilities. For example: "I am an HR assistant for Vipraco and can only answer questions about employee data, leave, payroll, and company policies. How can I help you with an HR-related query?"

**Database Schema:**
---
${schema}
---

**Sample Data (for reference on data format):**
---
${sample}
---

**Example questions you can answer:**
---
${exampleQueries}
---
`;
    } catch (error) {
        console.error("Error reading context files:", error);
        throw new Error("Could not build system prompt.");
    }
}

function isQuerySafe(sql) {
    const unsafeKeywords = [
        'DROP', 'TRUNCATE', 'ALTER', 'DELETE',
        'GRANT', 'REVOKE', 'COMMIT', 'ROLLBACK',
        'CREATE', 'RENAME', 'SHUTDOWN'
    ];
    const upperSql = sql.toUpperCase();
    
    // Check for semicolon to prevent multiple statements
    if (upperSql.split(';').length > 2) { // allow one semicolon at the end
        return false;
    }

    for (const keyword of unsafeKeywords) {
        if (upperSql.includes(keyword)) {
            return false;
        }
    }

    return true;
}


// --- API Endpoints ---

app.post('/api/ai-query', async (req, res) => {
    const { prompt } = req.body;
    const userId = req.headers['x-user-id'];
    const organizationId = req.headers['x-organization-id'];

    if (!prompt || !userId || !organizationId) {
        return res.status(400).json({ error: 'Missing prompt, x-user-id, or x-organization-id in request' });
    }

    try {
        const systemPrompt = await getSystemPrompt();
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

        const fullPrompt = `User's question: "${prompt}"\nMy user_id is: "${userId}"\nMy organization_id is: "${organizationId}"`;

        const result = await model.generateContent([systemPrompt, fullPrompt]);
        const response = await result.response;
        let responseText = response.text().trim();

        // Robustly extract JSON from markdown block if present
        const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
        if (jsonMatch) {
            responseText = jsonMatch[1].trim();
        }

        // The AI should now return JSON
        let parsedResponse;
        try {
            parsedResponse = JSON.parse(responseText);
        } catch (e) {
            console.error("Failed to parse JSON response from AI:", responseText);
            return res.status(500).json({ error: "Received an invalid response from the AI model." });
        }

        let { sql: generatedSql, confirmation_message: confirmationMessage } = parsedResponse;
        
        console.log("Cleaned SQL:", generatedSql);

        if (generatedSql.toUpperCase() === 'MULTI_ACTION_ERROR') {
            return res.status(400).json({ error: confirmationMessage || "The request involves multiple actions. Please send separate prompts." });
        }

        if (generatedSql.toUpperCase() === 'IRRELEVANT') {
            return res.status(400).json({ error: confirmationMessage || "This question is not relevant to HR data." });
        }

        if (!isQuerySafe(generatedSql)) {
            return res.status(403).json({ error: 'Generated query is not allowed for security reasons.' });
        }
        
        // Remove trailing semicolon if exists
        if (generatedSql.endsWith(';')) {
            generatedSql = generatedSql.slice(0, -1);
        }

        const [queryResult] = await dbPool.execute(generatedSql);

        // For SELECT, result is an array of rows. For others, it's an info object.
        if (Array.isArray(queryResult)) {
            res.json({ success: true, message: confirmationMessage, data: queryResult });
            return;
        }

        res.json({ success: true, message: confirmationMessage, details: queryResult });

    } catch (error) {
        console.error('Error processing AI query:', error);
        res.status(500).json({ error: 'Failed to process AI query.', details: error.message });
    }
});

app.get('/', (req, res) => {
    res.send('AI Backend is running!');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
}); 