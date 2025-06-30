import express from 'express';
import axios from 'axios';
import { createClient } from 'redis';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Initialize Express and Redis
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
const redisClient = createClient(process.env.REDIS_URL || 'redis://localhost:6379');

// Connect to Redis
redisClient.on('error', err => console.log('Redis Client Error', err));
await redisClient.connect();

// Configuration
const CONFIG = {
  languages: ['JavaScript', 'C#', 'C++', 'Java', 'Ruby', 'Go', 'Python', 'Custom'],
  models: {
    'gpt-4o-mini': { maxTokens: 128000, cost: 1 },
    'gpt-4o': { maxTokens: 128000, cost: 2 },
    'gpt-4-turbo': { maxTokens: 128000, cost: 3 },
    'claude-3-opus': { maxTokens: 200000, cost: 5 },
    'claude-3-5-sonnet': { maxTokens: 200000, cost: 4 }
  },
  apiEndpoint: 'https://best-ai-code-generator.toolzflow.app/api/chat/public',
  cacheTTL: 3600 // 1 hour cache
};

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Welcome Gate Route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// API Route
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, language = 'JavaScript', model = 'gpt-4o-mini' } = req.body;
    
    if (!CONFIG.languages.includes(language)) {
      return res.status(400).json({
        status: false,
        error: `Unsupported language. Available: ${CONFIG.languages.join(', ')}`
      });
    }

    if (!CONFIG.models[model]) {
      return res.status(400).json({
        status: false,
        error: `Unsupported model. Available: ${Object.keys(CONFIG.models).join(', ')}`
      });
    }

    const cacheKey = `codegen:${model}:${language}:${Buffer.from(prompt).toString('base64')}`;
    const cached = await redisClient.get(cacheKey);
    
    if (cached) {
      return res.json({
        status: true,
        code: cached,
        cached: true
      });
    }

    const finalPrompt = language === 'Custom' 
      ? prompt 
      : `Write ${language} code for: ${prompt}\n\nInclude comments and error handling.`;

    const response = await axios.post(
      CONFIG.apiEndpoint,
      {
        chatSettings: {
          model: model,
          temperature: 0.3,
          contextLength: CONFIG.models[model].maxTokens,
          includeProfileContext: false,
          includeWorkspaceInstructions: false,
          includeExampleMessages: false
        },
        messages: [
          {
            role: 'system',
            content: `You are an expert ${language} developer. Generate clean, efficient code with best practices.`
          },
          {
            role: 'user',
            content: finalPrompt
          }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'code_response',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                code: { type: 'string', description: 'Generated code' },
                explanation: { type: 'string', description: 'Brief code explanation' }
              },
              required: ['code']
            }
          }
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://best-ai-code-generator.toolzflow.app',
          'Referer': 'https://best-ai-code-generator.toolzflow.app/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'X-Request-ID': crypto.randomUUID()
        },
        timeout: 30000
      }
    );

    const result = response.data;
    const cleanCode = result.code
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .trim();

    if (cleanCode) {
      await redisClient.setEx(cacheKey, CONFIG.cacheTTL, cleanCode);
    }

    res.json({
      status: true,
      code: cleanCode || 'No code generated.',
      explanation: result.explanation,
      model: model,
      language: language,
      cached: false
    });
  } catch (error) {
    console.error('Generation error:', error);
    res.status(500).json({
      status: false,
      error: `Request failed: ${error.response?.data?.message || error.message}`,
      retryable: !error.response || error.response.status >= 500
    });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await redisClient.quit();
  process.exit();
});
