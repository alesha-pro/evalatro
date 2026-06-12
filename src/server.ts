import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BalatroBotClient } from "./client/balatrobot.js";
import { TOOLS, executeTool } from "./tools/registry.js";
import { computeLegalActions } from "./state/summarizer.js";
import { globalBus } from "./bus/index.js";

// Interactive path: lets a human's AI assistant (Claude Desktop, Cursor, etc.)
// drive Balatro. Both this server and the benchmark adapters read the SAME tool
// registry, so the action surface can never drift between them.

const client = new BalatroBotClient();
const server = new McpServer({ name: "balatro-mcp", version: "1.0.0" });

const asText = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });

for (const tool of TOOLS) {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.schema.shape },
    async (args: any) => {
      const summarized = await executeTool(client, tool.name, args ?? {});
      if (tool.kind !== "query") {
        globalBus.emit({
          type: "state", gameId: "mcp-live", model: "interactive",
          seed: summarized.seed || "?", ts: Date.now(), state: summarized as any,
        });
      }
      return asText(summarized);
    },
  );
}

// MCP-only convenience: the benchmark loop feeds legal actions to the model, but
// an interactive assistant benefits from being able to ask.
server.registerTool(
  "get_legal_actions",
  { description: "Get the actions that are legal in the current game state." },
  async () => {
    const raw = await client.gamestate();
    return asText(computeLegalActions(raw.state));
  },
);

async function main() {
  await server.connect(new StdioServerTransport());
  console.error("Balatro MCP server running on stdio");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
