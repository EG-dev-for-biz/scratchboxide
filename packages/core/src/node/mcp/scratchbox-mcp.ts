/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Scratchbox IDE — stdio MCP server entry point.
 *
 * Run via:
 *   node packages/core/dist/node/mcp/scratchbox-mcp.js [--workspace <dir>] [--tools tool1,tool2]
 *
 * Or from Claude Desktop / Claude Code config:
 *   {
 *     "mcpServers": {
 *       "scratchbox": {
 *         "command": "node",
 *         "args": ["<repo>/packages/core/dist/node/mcp/scratchbox-mcp.js",
 *                  "--workspace", "<repo>"]
 *       }
 *     }
 *   }
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { mergeStandalonePacks } from './standalone-packs';
import { ScratchboxMcpServer } from './ScratchboxMcpServer';

// ============================================================================
// CLI argument parsing
// ============================================================================

function parseArgs(argv: string[]): { workspaceRoot: string; allowedTools: string[] | undefined } {
    let workspaceRoot = process.cwd();
    let allowedTools: string[] | undefined;

    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--workspace' && argv[i + 1]) {
            workspaceRoot = argv[++i];
        } else if (argv[i] === '--tools' && argv[i + 1]) {
            allowedTools = argv[++i].split(',').map(t => t.trim()).filter(Boolean);
        }
    }

    return { workspaceRoot, allowedTools };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
    const { workspaceRoot, allowedTools } = parseArgs(process.argv);

    // every standalone pack the in-app chat has (standalone-packs.ts), not one pack: the MCP is the app's toolbox
    const { declarations, handlers, unhandled } = mergeStandalonePacks();
    if (unhandled.length) process.stderr.write(`[scratchbox-mcp] declared without a handler, not served: ${unhandled.join(', ')}\n`);
    const mcpServer = new ScratchboxMcpServer(declarations, handlers, { workspaceRoot, allowedTools });

    const transport = new StdioServerTransport();

    process.on('SIGINT', async () => {
        await mcpServer.close();
        process.exit(0);
    });

    await mcpServer.connect(transport);
    // Server stays alive; stdin keeps the process running.
}

main().catch(err => {
    process.stderr.write(`[scratchbox-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
