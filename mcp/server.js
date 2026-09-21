#!/usr/bin/env node
import { join } from 'node:path'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { createTools } from './src/tools.js'

/**
 * The only file that knows about the MCP protocol. Everything it does is a thin
 * call into src/tools.js, so an SDK change touches this file and nothing else.
 *
 * stdio, not HTTP: the server is spawned per Claude Code session with cwd set to
 * the project, which is what makes project resolution automatic and what lets
 * the tools work with no daemon running.
 */

const registryFile = join(process.env.HOME ?? process.cwd(), '.docket', 'projects.json')
const tools = createTools({ registryFile, cwd: process.cwd() })

const server = new McpServer(
  { name: 'docket', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

/** MCP wants content blocks; a failure should read as a message, not a stack. */
const run = (work) => async (args) => {
  try {
    const result = await work(args ?? {})
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (error) {
    return { content: [{ type: 'text', text: `docket error: ${error.message}` }], isError: true }
  }
}

const project = z
  .string()
  .optional()
  .describe('Project slug. Omit to use the project containing the current directory.')

server.registerTool(
  'docket_projects',
  {
    title: 'List Docket projects',
    description:
      'Every project with a Docket board: slug, path, card count, columns. Use this when you need a board other than the one you are working in.',
    inputSchema: {},
  },
  run(() => tools.projects()),
)

server.registerTool(
  'docket_board',
  {
    title: 'Read a Docket board',
    description:
      'The cards on a board, with per-column counts. Notes are the conversation between the owner and Claude; origin is a card\'s provenance line (channel · id · date · link) and the place for source metadata; attachments carry an absolute path — reading one is a model prompt, so read it only when the work needs it.',
    inputSchema: {
      project,
      column: z.string().optional().describe('Only cards in this column, e.g. "loop".'),
      tag: z.string().optional().describe('Only cards carrying this tag.'),
    },
  },
  run((args) => tools.board(args)),
)

server.registerTool(
  'docket_add',
  {
    title: 'Add a card',
    description:
      'Create a card, authored by Claude. Defaults to the first column (Inbox). Never add a card directly to Loop — that column is the owner\'s authorization, not yours.',
    inputSchema: {
      project,
      title: z.string().describe('One line. The card face shows this first.'),
      detail: z.string().optional().describe('The body. Two clamped lines show on the card face.'),
      tags: z.array(z.string()).optional().describe('Free-form tags; the board colours them.'),
      column: z.string().optional().describe('Column key. Defaults to the first column.'),
      note: z.string().optional().describe('An opening note, authored by Claude.'),
      origin: z
        .string()
        .optional()
        .describe(
          'A short provenance line — channel · id · date, and a link if there is one, e.g. "trello · a1b2c3d4 · https://trello.com/c/a1b2c3d4". Shown in the panel\'s Source row and on the card face. Source metadata belongs here, never in a note.',
        ),
    },
  },
  run((args) => tools.add(args)),
)

server.registerTool(
  'docket_update',
  {
    title: 'Update a card',
    description:
      'Change a card\'s title, detail, tags, column, or priority flag. Moving a column restarts the card\'s column clock. Only the fields you pass are touched.',
    inputSchema: {
      project,
      id: z.string().describe('Card id, from docket_board.'),
      title: z.string().optional(),
      detail: z.string().optional(),
      tags: z.array(z.string()).optional().describe('Replaces the whole tag list.'),
      column: z.string().optional(),
      flag: z.boolean().optional().describe('The priority flag.'),
    },
  },
  run((args) => tools.update(args)),
)

server.registerTool(
  'docket_note',
  {
    title: 'Add a note to a card',
    description:
      'Append to the card\'s note thread, authored by Claude. This is how work gets reported: what you did, what you verified, what you could not. Append-only — it never overwrites the owner\'s notes.',
    inputSchema: {
      project,
      id: z.string().describe('Card id, from docket_board.'),
      text: z.string().describe('The note. Commit SHAs and paths become links on the board.'),
    },
  },
  run((args) => tools.note(args)),
)

server.registerTool(
  'docket_delete',
  {
    title: 'Delete a card',
    description:
      'Remove a card and its notes. Prefer moving a card to a column over deleting it — the notes are usually the record worth keeping.',
    inputSchema: {
      project,
      id: z.string().describe('Card id, from docket_board.'),
    },
  },
  run((args) => tools.remove(args)),
)

await server.connect(new StdioServerTransport())
