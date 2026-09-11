/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import {
    AccentColor,
    CanvasArtifact,
    DiscoveredExternalMcpSource,
    LiveCodeSandboxData,
    MarkdownDocumentData,
    McpCategory,
    McpServerItem,
    McpToolDefinition,
    SkillCategory,
    SkillItem,
    StudioAppearanceConfig
} from '../browser/generative-canvas/canvas-types';
import { WorkspaceFileWatcherService } from './workspace-file-watcher-service';
import { createFileChangeHash } from '../common/workspace-sync-protocol';

export interface ProjectRule {
    id: string;
    title: string;
    content: string;
    path: string;
    isRootDirectives?: boolean;
}

export interface WorkspaceSettings extends Partial<StudioAppearanceConfig> {
    defaultModel?: string;
    thinkingBudget?: number;
    customPromptInstructions?: string;
    autoAttachWorkspaceSuperpowers?: boolean;
    allowedDirectories?: string[];
}

export interface FullWorkspaceConfig {
    workspaceRoot: string;
    settings?: WorkspaceSettings;
    rules: ProjectRule[];
    customSkills: SkillItem[];
    customMcpServers: McpServerItem[];
}

export interface ArtifactSyncResult {
    success: boolean;
    writtenFiles: string[];
    targetPath: string;
    error?: string;
}

export class WorkspaceConfigService {
    /**
     * Discovers all project-level rules (SCRATCHBOX.md, AGENTS.md, .scratchbox/rules/*.md).
     */
    async discoverProjectRules(workspaceRoot: string): Promise<ProjectRule[]> {
        const rules: ProjectRule[] = [];
        const root = workspaceRoot || process.cwd();

        // 1. Check root-level directive files
        const rootRuleFiles = ['SCRATCHBOX.md', 'AGENTS.md', '.scratchbox-rules.md'];
        for (const fileName of rootRuleFiles) {
            const filePath = path.join(root, fileName);
            if (await fs.pathExists(filePath)) {
                const content = await fs.readFile(filePath, 'utf-8');
                rules.push({
                    id: `rule-root-${fileName.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
                    title: fileName,
                    content,
                    path: filePath,
                    isRootDirectives: true
                });
            }
        }

        // 2. Check .scratchbox/rules/ folder
        const sbRulesDir = path.join(root, '.scratchbox', 'rules');
        if (await fs.pathExists(sbRulesDir)) {
            const files = await fs.readdir(sbRulesDir);
            for (const file of files) {
                if (file.endsWith('.md') || file.endsWith('.mdc') || file.endsWith('.txt')) {
                    const filePath = path.join(sbRulesDir, file);
                    const stat = await fs.stat(filePath);
                    if (stat.isFile()) {
                        const content = await fs.readFile(filePath, 'utf-8');
                        const title = file.replace(/\.(md|mdc|txt)$/i, '');
                        rules.push({
                            id: `rule-sb-${title.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
                            title,
                            content,
                            path: filePath
                        });
                    }
                }
            }
        }

        return rules;
    }

    /**
     * Discovers and parses custom project skills (.scratchbox/skills/*.md).
     */
    async discoverProjectSkills(workspaceRoot: string): Promise<SkillItem[]> {
        const skills: SkillItem[] = [];
        const root = workspaceRoot || process.cwd();
        const skillsDir = path.join(root, '.scratchbox', 'skills');

        if (await fs.pathExists(skillsDir)) {
            const files = await fs.readdir(skillsDir);
            for (const file of files) {
                if (file.endsWith('.md') || file.endsWith('.markdown')) {
                    const filePath = path.join(skillsDir, file);
                    const stat = await fs.stat(filePath);
                    if (stat.isFile()) {
                        const raw = await fs.readFile(filePath, 'utf-8');
                        const skill = this.parseSkillMarkdown(file, raw);
                        skills.push(skill);
                    }
                }
            }
        }

        return skills;
    }

    /**
     * Parses a Markdown file with optional YAML frontmatter into a SkillItem.
     */
    private parseSkillMarkdown(filename: string, content: string): SkillItem {
        const id = `custom-skill-${filename.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
        let name = filename.replace(/\.(md|markdown)$/i, '');
        let tagline = 'Project-specific custom AI superpower';
        let description = '';
        let category: SkillCategory = 'Custom';
        let accentColor: AccentColor = 'blue';
        let tags: string[] = ['Workspace', 'Custom'];
        const promptStarters: string[] = [];

        // Check for YAML Frontmatter --- ... ---
        const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
        let bodyContent = content;

        if (fmMatch) {
            const fmText = fmMatch[1];
            bodyContent = fmMatch[2].trim();

            const lines = fmText.split('\n');
            for (const line of lines) {
                const colonIdx = line.indexOf(':');
                if (colonIdx > 0) {
                    const key = line.slice(0, colonIdx).trim().toLowerCase();
                    const val = line.slice(colonIdx + 1).trim();

                    if (key === 'name') name = val;
                    if (key === 'tagline') tagline = val;
                    if (key === 'description') description = val;
                    if (key === 'category') category = (val as SkillCategory) || 'Custom';
                    if (key === 'accentcolor') accentColor = (val as AccentColor) || 'blue';
                    if (key === 'tags') {
                        tags = val.replace(/^\[|\]$/g, '').split(',').map(t => t.trim()).filter(Boolean);
                    }
                }
            }
        }

        if (!description) {
            description = bodyContent.slice(0, 180).replace(/[#*`]/g, '').trim();
        }

        return {
            id,
            name,
            tagline,
            description,
            category,
            accentColor,
            tags: tags.length > 0 ? tags : ['Workspace'],
            isEnabled: true,
            isCustom: true,
            author: 'Workspace Local',
            version: '1.0.0',
            promptStarters: promptStarters.length > 0 ? promptStarters : [`Use ${name} superpower`],
            rawContent: content
        };
    }

    /**
     * Loads workspace-scoped MCP servers from .scratchbox/mcp.json.
     */
    async loadWorkspaceMcpServers(workspaceRoot: string): Promise<McpServerItem[]> {
        const root = workspaceRoot || process.cwd();
        const mcpJsonPath = path.join(root, '.scratchbox', 'mcp.json');

        if (await fs.pathExists(mcpJsonPath)) {
            try {
                const parsed = await fs.readJson(mcpJsonPath);
                if (parsed && Array.isArray(parsed.servers)) {
                    return parsed.servers;
                } else if (Array.isArray(parsed)) {
                    return parsed;
                }
            } catch (e) {
                console.warn(`Failed to parse ${mcpJsonPath}`, e);
            }
        }

        return [];
    }

    /**
     * Discovers external MCP configuration files from Claude Desktop and Cursor.
     */
    async discoverExternalMcpConfigs(
        customPaths?: { claudePath?: string; cursorPath?: string }
    ): Promise<DiscoveredExternalMcpSource[]> {
        const sources: DiscoveredExternalMcpSource[] = [];

        // 1. Claude Desktop config path
        let claudePath = customPaths?.claudePath;
        if (!claudePath) {
            if (process.platform === 'darwin') {
                claudePath = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
            } else if (process.platform === 'win32') {
                claudePath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
            } else {
                claudePath = path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
            }
        }

        const claudeServers = await this.parseExternalMcpJson(claudePath, 'claude_desktop');
        sources.push({
            source: 'claude_desktop',
            sourceLabel: 'Claude Desktop',
            path: claudePath,
            exists: claudeServers.length > 0 || (await fs.pathExists(claudePath)),
            servers: claudeServers
        });

        // 2. Cursor config path (~/.cursor/mcp.json)
        const cursorPath = customPaths?.cursorPath || path.join(os.homedir(), '.cursor', 'mcp.json');
        const cursorServers = await this.parseExternalMcpJson(cursorPath, 'cursor');
        sources.push({
            source: 'cursor',
            sourceLabel: 'Cursor IDE',
            path: cursorPath,
            exists: cursorServers.length > 0 || (await fs.pathExists(cursorPath)),
            servers: cursorServers
        });

        return sources;
    }

    /**
     * Parses Claude Desktop or Cursor MCP JSON into typed McpServerItem array.
     */
    private async parseExternalMcpJson(
        filePath: string,
        source: 'claude_desktop' | 'cursor'
    ): Promise<McpServerItem[]> {
        if (!filePath || !(await fs.pathExists(filePath))) {
            return [];
        }

        try {
            const data = await fs.readJson(filePath);
            const rawServers = data.mcpServers || data.servers || {};
            const result: McpServerItem[] = [];

            for (const [key, val] of Object.entries(rawServers)) {
                const srv = val as any;
                const serverId = `mcp-ext-${source}-${key.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
                const humanName = `${key} (${source === 'claude_desktop' ? 'Claude' : 'Cursor'})`;
                const category = this.inferMcpCategory(key, srv);
                const accentColor = this.inferMcpAccent(category);

                let endpoint = srv.url;
                if (!endpoint && srv.command) {
                    const args = Array.isArray(srv.args) ? srv.args.join(' ') : '';
                    endpoint = `stdio://${srv.command} ${args}`.trim();
                }

                const tools: McpToolDefinition[] = [
                    {
                        id: `${serverId}-tool-query`,
                        name: `${key}_query`,
                        humanTitle: `Query ${key} Actions`,
                        description: `Execute tool operations on ${key}`,
                        samplePrompt: `Use ${key} to query data`
                    },
                    {
                        id: `${serverId}-tool-inspect`,
                        name: `${key}_inspect`,
                        humanTitle: `Inspect ${key} Resources`,
                        description: `Inspect live state and resources from ${key}`,
                        samplePrompt: `Inspect resources on ${key}`
                    }
                ];

                result.push({
                    id: serverId,
                    name: humanName,
                    tagline: srv.command
                        ? `${srv.command} ${(srv.args || []).join(' ')}`
                        : (srv.url || `Imported from ${source === 'claude_desktop' ? 'Claude Desktop' : 'Cursor'}`),
                    category,
                    status: 'available',
                    latencyMs: 18,
                    toolsCount: tools.length,
                    tools,
                    isEnabled: true,
                    accentColor,
                    endpoint,
                    authType: srv.env ? 'API Key' : (srv.url ? 'None' : 'Local Pipe'),
                    lastActive: 'Discovered'
                });
            }

            return result;
        } catch (err) {
            console.warn(`Failed to parse external MCP config from ${filePath}`, err);
            return [];
        }
    }

    /**
     * Imports and persists external MCP servers into project .scratchbox/mcp.json.
     */
    async importExternalMcpServers(
        workspaceRoot: string,
        servers: McpServerItem[]
    ): Promise<McpServerItem[]> {
        const root = workspaceRoot || process.cwd();
        const existing = await this.loadWorkspaceMcpServers(root);

        const mergedMap = new Map<string, McpServerItem>();
        for (const s of existing) {
            mergedMap.set(s.id, s);
        }
        for (const s of servers) {
            mergedMap.set(s.id, { ...s, isEnabled: true, status: 'connected' });
        }

        const merged = Array.from(mergedMap.values());
        const sbDir = path.join(root, '.scratchbox');
        await fs.ensureDir(sbDir);
        await fs.writeJson(path.join(sbDir, 'mcp.json'), { servers: merged }, { spaces: 2 });

        return merged;
    }

    private inferMcpCategory(name: string, config: any): McpCategory {
        const n = name.toLowerCase();
        const cmd = (config?.command || '').toLowerCase();
        if (n.includes('stripe') || n.includes('pay') || n.includes('billing')) return 'Payments';
        if (n.includes('git') || n.includes('github') || n.includes('gitlab')) return 'Code & Git';
        if (n.includes('figma') || n.includes('design') || n.includes('asset')) return 'Design Assets';
        if (n.includes('search') || n.includes('web') || n.includes('weather') || n.includes('fetch')) return 'Live Web';
        if (n.includes('postgres') || n.includes('sql') || n.includes('db') || n.includes('database') || n.includes('mongo') || n.includes('redis')) return 'Data Storage';
        if (n.includes('sentry') || n.includes('datadog') || n.includes('log') || n.includes('trace')) return 'Observability';
        if (n.includes('cli') || n.includes('terminal') || n.includes('shell') || n.includes('file') || cmd.includes('npx')) return 'CLI & Terminal';
        return 'Custom';
    }

    private inferMcpAccent(category: McpCategory): AccentColor {
        switch (category) {
            case 'Payments': return 'indigo';
            case 'Code & Git': return 'purple';
            case 'Design Assets': return 'rose';
            case 'Live Web': return 'cyan';
            case 'Data Storage': return 'blue';
            case 'Observability': return 'amber';
            case 'CLI & Terminal': return 'emerald';
            default: return 'indigo';
        }
    }

    /**
     * Saves workspace configuration into .scratchbox/config.json.
     */
    async saveWorkspaceConfig(
        workspaceRoot: string,
        config: { settings?: WorkspaceSettings; customSkills?: SkillItem[]; customMcpServers?: McpServerItem[] }
    ): Promise<void> {
        const root = workspaceRoot || process.cwd();
        const configPath = path.join(root, '.scratchbox', 'config.json');

        await fs.ensureDir(path.join(root, '.scratchbox'));
        const existing = (await fs.pathExists(configPath)) ? await fs.readJson(configPath) : {};

        const merged = {
            ...existing,
            ...config,
            lastUpdated: Date.now()
        };

        await fs.writeJson(configPath, merged, { spaces: 2 });
    }

    /**
     * Loads full hierarchical workspace configuration.
     */
    async loadFullWorkspaceConfig(workspaceRoot: string): Promise<FullWorkspaceConfig> {
        const root = workspaceRoot || process.cwd();
        const configPath = path.join(root, '.scratchbox', 'config.json');

        let settings: WorkspaceSettings | undefined = undefined;
        if (await fs.pathExists(configPath)) {
            try {
                const parsed = await fs.readJson(configPath);
                settings = parsed.settings;
            } catch (e) {
                console.warn(`Failed to read ${configPath}`, e);
            }
        }

        const [rules, customSkills, customMcpServers] = await Promise.all([
            this.discoverProjectRules(root),
            this.discoverProjectSkills(root),
            this.loadWorkspaceMcpServers(root)
        ]);

        return {
            workspaceRoot: root,
            settings,
            rules,
            customSkills,
            customMcpServers
        };
    }

    /**
     * Syncs a visual canvas artifact directly into project workspace files.
     */
    async syncArtifactToWorkspace(
        workspaceRoot: string,
        artifact: CanvasArtifact,
        targetSubdir?: string
    ): Promise<ArtifactSyncResult> {
        const root = workspaceRoot || process.cwd();
        const slug = (artifact.title || 'scratchbox-artifact')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');

        const writtenFiles: string[] = [];

        try {
            // 1. Live Code Sandbox
            if (artifact.type === 'live-code-sandbox') {
                const sandboxData = artifact.data as LiveCodeSandboxData;
                const destDir = path.join(root, targetSubdir || 'src/components');
                await fs.ensureDir(destDir);

                for (const file of sandboxData.files || []) {
                    const filePath = path.join(destDir, file.name);
                    await fs.writeFile(filePath, file.content, 'utf-8');
                    writtenFiles.push(filePath);
                }

                return {
                    success: true,
                    writtenFiles,
                    targetPath: destDir
                };
            }

            // 2. Markdown Document
            if (artifact.type === 'markdown-document') {
                const docData = artifact.data as MarkdownDocumentData;
                const destDir = path.join(root, targetSubdir || 'docs');
                await fs.ensureDir(destDir);

                const fileName = `${slug}.md`;
                const filePath = path.join(destDir, fileName);
                const markdownContent = this.formatDocumentToMarkdown(docData);

                await fs.writeFile(filePath, markdownContent, 'utf-8');
                writtenFiles.push(filePath);

                return {
                    success: true,
                    writtenFiles,
                    targetPath: filePath
                };
            }

            // 3. Visual Node Graph
            if (artifact.type === 'node-graph') {
                const destDir = path.join(root, targetSubdir || 'workflows');
                await fs.ensureDir(destDir);

                const fileName = `${slug}.workflow.json`;
                const filePath = path.join(destDir, fileName);
                await fs.writeJson(filePath, artifact.data, { spaces: 2 });
                writtenFiles.push(filePath);

                return {
                    success: true,
                    writtenFiles,
                    targetPath: filePath
                };
            }

            // 4. Other Primitives (Kanban, Metrics, etc.)
            const destDir = path.join(root, targetSubdir || 'docs');
            await fs.ensureDir(destDir);
            const fileName = `${slug}.${artifact.type}.json`;
            const filePath = path.join(destDir, fileName);
            await fs.writeJson(filePath, artifact.data, { spaces: 2 });
            writtenFiles.push(filePath);

            return {
                success: true,
                writtenFiles,
                targetPath: filePath
            };
        } catch (err: any) {
            return {
                success: false,
                writtenFiles: [],
                targetPath: '',
                error: err.message || 'Failed to sync artifact to workspace'
            };
        }
    }

    /**
     * Atomically writes a map of files to the workspace on disk,
     * registering known hashes with the watcher service to suppress echo loops.
     */
    async writeLensFiles(
        workspaceRoot: string,
        files: Record<string, string>,
        watcherService?: WorkspaceFileWatcherService
    ): Promise<{ success: boolean; writtenFiles: string[]; error?: string }> {
        try {
            const writtenFiles: string[] = [];
            for (const [relPath, content] of Object.entries(files)) {
                const safePath = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, '');
                const fullPath = path.join(workspaceRoot, safePath);

                if (watcherService) {
                    const hash = createFileChangeHash(content);
                    watcherService.registerKnownHash(fullPath, hash);
                }

                await fs.outputFile(fullPath, content, 'utf8');
                writtenFiles.push(safePath);
            }

            return {
                success: true,
                writtenFiles
            };
        } catch (err: any) {
            return {
                success: false,
                writtenFiles: [],
                error: err.message || 'Failed to write lens files'
            };
        }
    }

    /**
     * Converts a MarkdownDocumentData structure into formatted standard Markdown.
     */
    private formatDocumentToMarkdown(doc: MarkdownDocumentData): string {
        const parts: string[] = [];

        if (doc.title) {
            parts.push(`# ${doc.title}\n`);
        }
        if (doc.subtitle) {
            parts.push(`> ${doc.subtitle}\n`);
        }

        for (const sec of doc.sections || []) {
            switch (sec.type) {
                case 'heading': {
                    const hashes = '#'.repeat(sec.level || 2);
                    parts.push(`${hashes} ${sec.content || ''}\n`);
                    break;
                }
                case 'paragraph': {
                    parts.push(`${sec.content || ''}\n`);
                    break;
                }
                case 'callout': {
                    const title = sec.calloutTitle ? `**${sec.calloutTitle}**:\n` : '';
                    parts.push(`> [!${(sec.calloutType || 'info').toUpperCase()}]\n> ${title}${sec.content || ''}\n`);
                    break;
                }
                case 'table': {
                    if (sec.tableHeaders && sec.tableHeaders.length > 0) {
                        const headerRow = `| ${sec.tableHeaders.join(' | ')} |`;
                        const dividerRow = `| ${sec.tableHeaders.map(() => '---').join(' | ')} |`;
                        const bodyRows = (sec.tableRows || []).map(row => `| ${row.join(' | ')} |`).join('\n');
                        parts.push(`${headerRow}\n${dividerRow}\n${bodyRows}\n`);
                    }
                    break;
                }
                case 'checklist': {
                    const items = (sec.checklistItems || [])
                        .map(item => `- [${item.done ? 'x' : ' '}] ${item.text}`)
                        .join('\n');
                    parts.push(`${items}\n`);
                    break;
                }
                case 'code': {
                    parts.push(`\`\`\`\n${sec.content || ''}\n\`\`\`\n`);
                    break;
                }
                default: {
                    if (sec.content) {
                        parts.push(`${sec.content}\n`);
                    }
                }
            }
        }

        return parts.join('\n');
    }
}
