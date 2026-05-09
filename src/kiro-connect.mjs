#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const version = '0.1.3';
const telegramMessageLimit = 3900;
const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), '..');
const home = os.homedir();

loadEnvFile(path.join(home, '.kiro-connect', '.env'));
loadEnvFile(path.join(projectRoot, '.env'));

const config = {
  token: env('KIRO_CONNECT_TELEGRAM_TOKEN') || env('TELEGRAM_BOT_TOKEN'),
  allowedUsers: parseCsv(env('KIRO_CONNECT_ALLOWED_USERS')),
  kiroCli: env('KIRO_CONNECT_KIRO_CLI') || path.join(home, '.local', 'bin', 'kiro-cli'),
  defaultWorkDir: env('KIRO_CONNECT_WORK_DIR') || path.join(home, 'claudews'),
  defaultModel: env('KIRO_CONNECT_MODEL') || '',
  defaultAgent: env('KIRO_CONNECT_AGENT') || '',
  stateDir: env('KIRO_CONNECT_STATE_DIR') || path.join(home, '.kiro-connect'),
  timeoutMs: Number(env('KIRO_CONNECT_TIMEOUT_MS') || 900000),
  trustAllTools: parseBool(env('KIRO_CONNECT_TRUST_ALL_TOOLS'), true),
  trustTools: env('KIRO_CONNECT_TRUST_TOOLS'),
  streamOutput: parseBool(env('KIRO_CONNECT_STREAM_OUTPUT'), true),
  streamIntervalMs: Number(env('KIRO_CONNECT_STREAM_INTERVAL_MS') || 1200)
};

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log(`kiro-connect ${version}`);
  process.exit(0);
}

const commandRegistry = discoverKiroCommands(config.kiroCli);

if (argv.includes('--print-commands')) {
  const commands = buildTelegramCommands(commandRegistry);
  console.log(commands.map(c => `/${c.command} - ${c.description}`).join('\n'));
  process.exit(0);
}

if (!config.token) {
  console.error('Missing KIRO_CONNECT_TELEGRAM_TOKEN. Put the new bot token in ~/.kiro-connect/.env.');
  process.exit(1);
}

fs.mkdirSync(config.stateDir, { recursive: true });
fs.mkdirSync(path.join(config.stateDir, 'logs'), { recursive: true });

const statePath = path.join(config.stateDir, 'state.json');
const state = readJson(statePath, { chats: {} });
const queues = new Map();
let botName = '';

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await main();

async function main() {
  const me = await telegram('getMe', {});
  botName = me.username || '';
  log(`Kiro Connect ${version} started as @${botName || 'unknown'}`);
  log(`Kiro CLI: ${config.kiroCli}`);
  log(`Default workdir: ${config.defaultWorkDir}`);

  await registerCommands();
  await pollUpdates();
}

async function pollUpdates() {
  let offset = Number(readJson(path.join(config.stateDir, 'offset.json'), { offset: 0 }).offset || 0);

  while (true) {
    try {
      const updates = await telegram('getUpdates', {
        offset,
        timeout: 50,
        allowed_updates: ['message', 'callback_query']
      });

      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        writeJson(path.join(config.stateDir, 'offset.json'), { offset });
        void handleUpdate(update).catch(err => {
          log(`update failed: ${err.stack || err.message}`);
        });
      }
    } catch (err) {
      log(`poll failed: ${err.message}`);
      await sleep(3000);
    }
  }
}

async function handleUpdate(update) {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  const message = update.message;
  if (!message || !message.chat || typeof message.text !== 'string') return;

  const chatId = String(message.chat.id);
  const userId = String(message.from?.id || '');
  if (!isAllowed(userId)) {
    await sendMessage(chatId, `This bot is not authorized for your Telegram user id: ${userId}`);
    return;
  }

  enqueue(chatId, async () => {
    const text = message.text.trim();
    if (!text) return;
    if (text.startsWith('/')) {
      await handleSlashCommand(chatId, userId, text);
    } else {
      await handleChatMessage(chatId, text);
    }
  });
}

async function handleCallbackQuery(query) {
  const chatId = String(query.message?.chat?.id || '');
  const messageId = query.message?.message_id;
  const userId = String(query.from?.id || '');

  if (!chatId || !messageId) {
    await answerCallbackQuery(query.id, 'This button is no longer available.');
    return;
  }

  if (!isAllowed(userId)) {
    await answerCallbackQuery(query.id, 'You are not authorized to use this bot.');
    return;
  }

  enqueue(chatId, async () => {
    const data = String(query.data || '');
    if (data.startsWith('model:')) {
      await handleModelCallback(query, chatId, messageId, data);
      return;
    }
    await answerCallbackQuery(query.id, 'Unknown action.');
  });
}

async function handleSlashCommand(chatId, userId, text) {
  const parsed = parseTelegramCommand(text);
  if (!parsed) return;

  const { command, rest } = parsed;
  const chat = getChatState(chatId);

  if (command === 'start') {
    await sendMessage(chatId, startText(chatId, userId, chat));
    return;
  }

  if (command === 'kc') {
    await sendMessage(chatId, statusText(chatId, chat));
    return;
  }

  if (command === 'workdir') {
    await handleWorkDir(chatId, rest);
    return;
  }

  if (command === 'model') {
    await handleModel(chatId, rest);
    return;
  }

  if (command === 'agent_select') {
    await handleAgentSelect(chatId, rest);
    return;
  }

  if (command === 'models') {
    await runAndReply(chatId, ['chat', '--list-models', '--format', 'json-pretty']);
    return;
  }

  if (command === 'raw') {
    await runAndReply(chatId, splitArgs(rest));
    return;
  }

  const mapped = commandRegistry.mapping.get(command);
  if (mapped) {
    await runAndReply(chatId, [...mapped.args, ...splitArgs(rest)]);
    return;
  }

  const fallbackCommand = command.replaceAll('_', '-');
  await runAndReply(chatId, [fallbackCommand, ...splitArgs(rest)]);
}

async function handleChatMessage(chatId, text) {
  const chat = getChatState(chatId);
  const args = ['chat', '--no-interactive', '--resume', '--wrap', 'never'];
  if (chat.model) args.push('--model', chat.model);
  if (chat.agent) args.push('--agent', chat.agent);
  args.push(text);
  await runAndReply(chatId, args);
}

async function handleWorkDir(chatId, rest) {
  const chat = getChatState(chatId);
  const arg = rest.trim();
  if (!arg) {
    await sendMessage(chatId, `Current workdir:\n${chat.workDir}\n\nUsage:\n/workdir /absolute/path\n/workdir reset`);
    return;
  }

  if (arg === 'reset') {
    chat.workDir = config.defaultWorkDir;
    saveState();
    await sendMessage(chatId, `Workdir reset:\n${chat.workDir}`);
    return;
  }

  const next = path.resolve(chat.workDir, arg);
  if (!fs.existsSync(next) || !fs.statSync(next).isDirectory()) {
    await sendMessage(chatId, `Directory not found:\n${next}`);
    return;
  }

  chat.workDir = next;
  saveState();
  await sendMessage(chatId, `Workdir changed:\n${chat.workDir}`);
}

async function handleModel(chatId, rest) {
  const chat = getChatState(chatId);
  const arg = rest.trim();
  if (!arg) {
    await sendModelPicker(chatId);
    return;
  }

  if (arg === 'reset') {
    chat.model = '';
    saveState();
    await sendMessage(chatId, 'Model reset to Kiro default.');
    return;
  }

  chat.model = arg;
  saveState();
  await sendMessage(chatId, `Model changed:\n${chat.model}`);
}

async function handleModelCallback(query, chatId, messageId, data) {
  const chat = getChatState(chatId);

  if (data === 'model:reset') {
    chat.model = '';
    saveState();
    await answerCallbackQuery(query.id, 'Model reset to Kiro default.');
    await editMessageText(chatId, messageId, modelPickerText(chat, [], 'Model reset to Kiro default.'), {
      reply_markup: { inline_keyboard: [] }
    }).catch(() => sendMessage(chatId, 'Model reset to Kiro default.'));
    return;
  }

  const match = data.match(/^model:set:(\d+)$/);
  if (!match) {
    await answerCallbackQuery(query.id, 'Invalid model selection.');
    return;
  }

  let models;
  try {
    models = await getKiroModels(chat.workDir);
  } catch (err) {
    await answerCallbackQuery(query.id, 'Could not refresh model list.');
    await sendMessage(chatId, `Could not load Kiro models:\n${err.message}`);
    return;
  }

  const model = models[Number(match[1])];
  if (!model) {
    await answerCallbackQuery(query.id, 'Model list changed. Run /model again.');
    return;
  }

  const modelId = model.model_id || model.model_name;
  chat.model = modelId;
  saveState();
  await answerCallbackQuery(query.id, `Model set to ${modelId}`);
  await editMessageText(chatId, messageId, modelPickerText(chat, models, `Model changed to ${modelId}.`), {
    reply_markup: { inline_keyboard: buildModelKeyboard(models, chat.model) }
  }).catch(() => sendMessage(chatId, `Model changed:\n${modelId}`));
}

async function sendModelPicker(chatId) {
  const chat = getChatState(chatId);
  await telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

  try {
    const models = await getKiroModels(chat.workDir);
    await sendMessage(chatId, modelPickerText(chat, models), {
      reply_markup: { inline_keyboard: buildModelKeyboard(models, chat.model) }
    });
  } catch (err) {
    await sendMessage(chatId, `Could not load Kiro models:\n${err.message}\n\nFallback:\n/model claude-opus-4.7\n/model reset`);
  }
}

async function handleAgentSelect(chatId, rest) {
  const chat = getChatState(chatId);
  const arg = rest.trim();
  if (!arg) {
    await sendMessage(chatId, `Current agent:\n${chat.agent || '(Kiro default)'}\n\nUsage:\n/agent_select <agent-name>\n/agent_select reset`);
    return;
  }

  if (arg === 'reset') {
    chat.agent = '';
    saveState();
    await sendMessage(chatId, 'Agent reset to Kiro default.');
    return;
  }

  chat.agent = arg;
  saveState();
  await sendMessage(chatId, `Agent changed:\n${chat.agent}`);
}

async function runAndReply(chatId, args) {
  if (!args.length) {
    await sendMessage(chatId, 'Usage: /raw <kiro-cli arguments>');
    return;
  }

  const chat = getChatState(chatId);
  await telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  const finalArgs = withDefaultTrustArgs(args);
  log(`chat=${chatId} cwd=${chat.workDir} run: ${config.kiroCli} ${finalArgs.join(' ')}`);

  if (!config.streamOutput) {
    const result = await runKiro(finalArgs, { cwd: chat.workDir });
    const header = resultStatusText(result);
    const body = stripAnsi([result.stdout, result.stderr].filter(Boolean).join('\n').trim());
    await sendMessage(chatId, `${header}${body || '(no output)'}`);
    return;
  }

  const stream = createTelegramStream(chatId);
  await stream.start();
  const result = await runKiro(finalArgs, {
    cwd: chat.workDir,
    onOutput: chunk => stream.append(chunk)
  });
  await stream.finish(resultStatusText(result).trim());
}

function runKiro(args, options) {
  return new Promise(resolve => {
    const child = spawn(config.kiroCli, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, config.timeoutMs);

    child.stdout.on('data', chunk => {
      const text = chunk.toString('utf8');
      stdout += text;
      options.onOutput?.(text, 'stdout');
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString('utf8');
      stderr += text;
      options.onOutput?.(text, 'stderr');
    });
    child.on('error', err => {
      clearTimeout(timer);
      stderr = `${stderr}\n${err.message}`.trim();
      options.onOutput?.(`\n${err.message}`, 'stderr');
      resolve({ code: 1, stdout, stderr, timedOut });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function resultStatusText(result) {
  if (result.timedOut) return `Command timed out after ${config.timeoutMs} ms.\n\n`;
  if (result.code !== 0) return `Command exited with code ${result.code}.\n\n`;
  return '';
}

function createTelegramStream(chatId) {
  let output = '';
  let currentStart = 0;
  let currentMessageId = null;
  let currentRendered = '';
  let flushTimer = null;
  let flushQueue = Promise.resolve();
  let closed = false;

  async function start() {
    if (currentMessageId) return;
    const message = await sendSingleMessage(chatId, 'Kiro is running...');
    currentMessageId = message.message_id;
    currentRendered = 'Kiro is running...';
  }

  function append(chunk) {
    const text = stripAnsi(chunk);
    if (!text) return;
    output += text;
    if (!closed) scheduleFlush();
  }

  async function finish(notice = '') {
    closed = true;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await queueFlush();
    if (!output.trim()) {
      await upsertCurrent(`${notice ? `${notice}\n` : ''}(no output)`);
      return;
    }
    if (notice) {
      await sendMessage(chatId, notice);
    }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void queueFlush();
    }, Math.max(250, config.streamIntervalMs));
  }

  function queueFlush() {
    flushQueue = flushQueue
      .then(flushNow)
      .catch(err => log(`stream flush failed: ${err.message}`));
    return flushQueue;
  }

  async function flushNow() {
    await start();
    if (!output) return;

    while (output.length - currentStart > telegramMessageLimit) {
      await upsertCurrent(output.slice(currentStart, currentStart + telegramMessageLimit));
      currentStart += telegramMessageLimit;
      currentMessageId = null;
      currentRendered = '';
    }

    const chunk = output.slice(currentStart);
    if (chunk) {
      await upsertCurrent(chunk);
    }
  }

  async function upsertCurrent(text) {
    const safeText = String(text || '(empty)').slice(0, telegramMessageLimit);
    if (!currentMessageId) {
      const message = await sendSingleMessage(chatId, safeText);
      currentMessageId = message.message_id;
      currentRendered = safeText;
      return;
    }
    if (safeText === currentRendered) return;

    try {
      await editMessageText(chatId, currentMessageId, safeText);
      currentRendered = safeText;
    } catch (err) {
      if (String(err.message || '').includes('message is not modified')) return;
      const message = await sendSingleMessage(chatId, safeText);
      currentMessageId = message.message_id;
      currentRendered = safeText;
    }
  }

  return { start, append, finish };
}

function withDefaultTrustArgs(args) {
  if (!shouldApplyTrustArgs(args) || hasTrustArgs(args)) return args;
  const trustArgs = buildTrustArgs();
  if (!trustArgs.length) return args;
  return [args[0], ...trustArgs, ...args.slice(1)];
}

function shouldApplyTrustArgs(args) {
  return args[0] === 'chat' && !args.includes('--list-models');
}

function hasTrustArgs(args) {
  return args.some(arg => arg === '--trust-all-tools' || arg.startsWith('--trust-tools'));
}

function buildTrustArgs() {
  if (config.trustAllTools) return ['--trust-all-tools'];
  if (config.trustTools !== undefined) return [`--trust-tools=${config.trustTools}`];
  return [];
}

async function getKiroModels(cwd) {
  const result = await runKiro(['chat', '--list-models', '--format', 'json'], { cwd });
  const body = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (result.code !== 0) {
    throw new Error(body || `kiro-cli exited with code ${result.code}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stripAnsi(result.stdout || body));
  } catch {
    throw new Error(`Could not parse model list JSON:\n${body.slice(0, 500)}`);
  }

  if (!Array.isArray(parsed.models)) {
    throw new Error('Kiro model list did not contain a models array.');
  }

  return parsed.models;
}

function buildModelKeyboard(models, currentModel) {
  const rows = models.map((model, index) => ([{
    text: modelButtonText(model, currentModel),
    callback_data: `model:set:${index}`
  }]));
  rows.push([{ text: 'Use Kiro default', callback_data: 'model:reset' }]);
  return rows;
}

function modelButtonText(model, currentModel) {
  const id = model.model_id || model.model_name || 'unknown';
  const current = currentModel === id ? ' [current]' : '';
  const context = formatTokenCount(model.context_window_tokens);
  const rate = model.rate_multiplier !== undefined ? `x${model.rate_multiplier}` : '';
  const meta = [context, rate].filter(Boolean).join(', ');
  return `${id}${current}${meta ? ` (${meta})` : ''}`;
}

function modelPickerText(chat, models, notice = '') {
  const lines = [];
  if (notice) {
    lines.push(notice, '');
  }
  lines.push('Choose a Kiro model:');
  lines.push(`Current: ${chat.model || '(Kiro default)'}`);
  if (models.length) {
    lines.push('', 'Tap a button below to switch models.');
  }
  lines.push('', 'Manual fallback:');
  lines.push('/model claude-opus-4.7');
  lines.push('/model reset');
  return lines.join('\n');
}

function formatTokenCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1000000) return `${Math.round(n / 1000000)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

function discoverKiroCommands(kiroCli) {
  const mapping = new Map();
  const menu = [];
  const topHelp = runCapture(kiroCli, ['--help-all'], { timeoutMs: 5000 });
  const topCommands = parseCommands(topHelp.stdout || topHelp.stderr);

  for (const cmd of topCommands) {
    const commandName = sanitizeCommandName(cmd.name);
    if (!commandName) continue;
    mapping.set(commandName, { args: [cmd.name], description: cmd.description });
    menu.push({
      command: commandName,
      description: compactDescription(`Kiro: ${cmd.description || cmd.name}`)
    });

    if (cmd.name === 'help') continue;
    const subHelp = runCapture(kiroCli, [cmd.name, '--help'], { timeoutMs: 3000 });
    const subCommands = parseCommands(subHelp.stdout || subHelp.stderr).filter(sub => sub.name !== 'help');
    for (const sub of subCommands) {
      const subName = sanitizeCommandName(`${cmd.name}_${sub.name}`);
      if (!subName || mapping.has(subName)) continue;
      mapping.set(subName, { args: [cmd.name, sub.name], description: `${cmd.name} ${sub.name}: ${sub.description}` });
      menu.push({
        command: subName,
        description: compactDescription(`Kiro: ${cmd.name} ${sub.name} - ${sub.description || sub.name}`)
      });
    }
  }

  return { mapping, menu };
}

function buildTelegramCommands(registry) {
  const bridge = [
    { command: 'start', description: 'Show Kiro Connect help' },
    { command: 'kc', description: 'Show Kiro Connect status' },
    { command: 'workdir', description: 'View or change Kiro working directory' },
    { command: 'model', description: 'View or set chat model' },
    { command: 'models', description: 'List Kiro chat models' },
    { command: 'agent_select', description: 'Set default chat agent for this Telegram chat' },
    { command: 'raw', description: 'Run raw kiro-cli arguments' }
  ];

  const seen = new Set();
  const commands = [];
  for (const item of [...bridge, ...registry.menu]) {
    if (seen.has(item.command)) continue;
    seen.add(item.command);
    commands.push({
      command: item.command,
      description: compactDescription(item.description || item.command)
    });
  }
  return commands.slice(0, 100);
}

async function registerCommands() {
  const commands = buildTelegramCommands(commandRegistry);
  await telegram('setMyCommands', { commands });
  log(`registered ${commands.length} Telegram commands`);
}

async function telegram(method, payload) {
  const url = `https://api.telegram.org/bot${config.token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Telegram ${method}: invalid JSON response: ${text.slice(0, 300)}`);
  }
  if (!data.ok) {
    throw new Error(`Telegram ${method}: ${data.description || text}`);
  }
  return data.result;
}

async function sendMessage(chatId, text, extra = {}) {
  const chunks = chunkText(String(text || ''), telegramMessageLimit);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    await sendSingleMessage(chatId, chunk, i === 0 ? extra : {});
  }
}

async function sendSingleMessage(chatId, text, extra = {}) {
  return telegram('sendMessage', {
    chat_id: chatId,
    text: String(text || '(empty)').slice(0, telegramMessageLimit),
    disable_web_page_preview: true,
    ...extra
  });
}

async function editMessageText(chatId, messageId, text, extra = {}) {
  return telegram('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: String(text || '(empty)').slice(0, telegramMessageLimit),
    disable_web_page_preview: true,
    ...extra
  });
}

async function answerCallbackQuery(callbackQueryId, text = '') {
  return telegram('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: String(text || '').slice(0, 200),
    show_alert: false
  });
}

function getChatState(chatId) {
  if (!state.chats[chatId]) {
    state.chats[chatId] = {
      workDir: config.defaultWorkDir,
      model: config.defaultModel,
      agent: config.defaultAgent
    };
    saveState();
  }
  return state.chats[chatId];
}

function saveState() {
  writeJson(statePath, state);
}

function enqueue(chatId, fn) {
  const previous = queues.get(chatId) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  queues.set(chatId, next.finally(() => {
    if (queues.get(chatId) === next) queues.delete(chatId);
  }));
}

function isAllowed(userId) {
  if (!config.allowedUsers.length) return true;
  return config.allowedUsers.includes(String(userId));
}

function parseTelegramCommand(text) {
  const match = text.match(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  if (match[2] && botName && match[2].toLowerCase() !== botName.toLowerCase()) return null;
  return {
    command: match[1].toLowerCase(),
    rest: match[3] || ''
  };
}

function splitArgs(input) {
  const args = [];
  let current = '';
  let quote = '';
  let escaping = false;

  for (const ch of input) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (escaping) current += '\\';
  if (current) args.push(current);
  return args;
}

function parseCommands(helpText) {
  const lines = String(helpText || '').split(/\r?\n/);
  const commands = [];
  let inCommands = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'Commands:') {
      inCommands = true;
      continue;
    }
    if (!inCommands) continue;
    if (!trimmed) continue;
    if (/^(Options:|Arguments:|Usage:|USAGE:)/.test(trimmed)) break;

    const match = line.match(/^\s{2,}([a-z][a-z0-9-]*)\s{2,}(.+?)\s*$/);
    if (match) {
      commands.push({ name: match[1], description: match[2].trim() });
    }
  }
  return commands;
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs || 5000,
    env: process.env
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

function sanitizeCommandName(name) {
  return String(name || '')
    .toLowerCase()
    .replaceAll('-', '_')
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

function compactDescription(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.slice(0, 256) || 'Kiro CLI command';
}

function stripAnsi(text) {
  return String(text || '').replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function chunkText(text, size) {
  if (!text) return ['(empty)'];
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function startText(chatId, userId, chat) {
  return [
    'Kiro Connect is online.',
    '',
    `Telegram chat: ${chatId}`,
    `Telegram user: ${userId}`,
    `Workdir: ${chat.workDir}`,
    `Model: ${chat.model || '(Kiro default)'}`,
    `Agent: ${chat.agent || '(Kiro default)'}`,
    '',
    'Plain text messages are sent to local Kiro CLI chat.',
    'Slash commands are passed to local kiro-cli.',
    '',
    'Examples:',
    '/settings list',
    '/agent list',
    '/mcp list',
    '/doctor',
    '/workdir /path/to/project',
    '/model claude-opus-4.7'
  ].join('\n');
}

function statusText(chatId, chat) {
  return [
    `Kiro Connect ${version}`,
    `Chat: ${chatId}`,
    `Kiro CLI: ${config.kiroCli}`,
    `Workdir: ${chat.workDir}`,
    `Model: ${chat.model || '(Kiro default)'}`,
    `Agent: ${chat.agent || '(Kiro default)'}`,
    `Trust all tools: ${config.trustAllTools ? 'yes' : 'no'}`,
    `Stream output: ${config.streamOutput ? `yes (${config.streamIntervalMs} ms)` : 'no'}`,
    `Registered Kiro commands: ${commandRegistry.mapping.size}`
  ].join('\n');
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquoteEnv(match[2].trim());
  }
}

function unquoteEnv(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function env(name) {
  return process.env[name];
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shutdown(signal) {
  log(`received ${signal}, exiting`);
  process.exit(0);
}
