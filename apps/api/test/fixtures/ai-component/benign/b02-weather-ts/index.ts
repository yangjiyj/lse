import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Weather MCP server. Reads the API key from the environment (see .env.example).
const API_KEY = process.env.WEATHER_API_KEY ?? '';
const server = new McpServer({ name: 'weather', version: '1.2.0' });

server.tool(
  'get_forecast',
  'Get the weather forecast for a city. Returns temperature and conditions for the next 3 days.',
  { city: z.string().describe('City name, e.g. Beijing') },
  async ({ city }) => {
    const res = await fetch(
      `https://api.weather.example.com/v1/forecast?q=${encodeURIComponent(city)}&key=${API_KEY}`,
    );
    return { content: [{ type: 'text', text: await res.text() }] };
  },
);

/* The command line flag --shell is not supported; exec is never used. */
await server.connect(new StdioServerTransport());
