import { generateText, stepCountIs } from 'ai';
import { buildAgentTools } from './qig-tools';
import { putMemory } from './memory-store';
import { sendInboxMessage } from './inbox-store';
import { claimTask, getTask, listDueTasks, recordRun } from './task-store';

// Autonomous executor for scheduled tasks. When a task is due, the runner drives
// the helper agent with the full read-WRITE toolset so it can actually do work
// (write memory, send inbox mail, look up repos), then records the outcome on the
// task and broadcasts a result to the inbox.
//
// Credit discipline mirrors the daily reviewer: work happens only when a task is
// genuinely due, each run is step-capped, the council tool is excluded (it is the
// one unbounded-cost tool), and no more than MAX_TASKS_PER_TICK run per cron tick.

const MODEL = process.env.QIG_HELPER_MODEL || 'xai/grok-4.5';
const MAX_TASKS_PER_TICK = 3;
const MAX_STEPS = 10;

const SYSTEM_PROMPT = `You are the QIG scheduled-task executor: an autonomous operator on the QIG memory
mesh. You have been handed ONE task to carry out now, on a schedule, without a human in the loop.

Use your tools to actually complete the task — read and search memory, look up repositories, write or
update memory records, and send inbox messages as the task requires. Prefer durable, useful side effects
over commentary. If the task cannot be completed, say precisely why.

Operating rules:
- Do exactly what the task asks — no more. Do not invent extra work or convene expensive processes.
- Persist anything worth keeping to memory with a clear key and category; don't rely on your reply alone.
- Be concise. End with a 1-3 sentence summary of what you did and any follow-up an agent should know.`;

// Run a single already-claimed task. Returns the run record fields.
async function executeClaimed(task) {
  const detail = [
    `TASK: ${task.title}`,
    `PROJECT: ${task.project}`,
    task.repository ? `REPOSITORY: ${task.repository}` : null,
    task.concepts?.length ? `CONCEPTS: ${task.concepts.join(', ')}` : null,
    `PRIORITY: ${task.priority}`,
    '',
    'INSTRUCTION:',
    task.instruction,
  ]
    .filter(Boolean)
    .join('\n');

  let text = '';
  let ok = true;
  try {
    const result = await generateText({
      model: MODEL,
      system: SYSTEM_PROMPT,
      prompt: detail,
      // Full read-write toolset MINUS the council (unbounded cost). helper_ask
      // stays available for read-only API guidance.
      tools: buildAgentTools({ readOnly: false, excludeTools: ['council_convene'] }),
      stopWhen: stepCountIs(MAX_STEPS),
      maxOutputTokens: 2000,
      timeout: 90_000,
    });
    text = result.text?.trim() || '(no summary returned)';
  } catch (error) {
    ok = false;
    text = `Execution error: ${error?.message?.slice(0, 400) || 'unknown error'}`;
  }

  // Durable dated record of the run for later recall/audit.
  let memoryKey = null;
  try {
    const key = `task_run_${task.id.slice(0, 8)}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
    await putMemory(key, {
      category: 'task_run',
      content: JSON.stringify({ taskId: task.id, title: task.title, ok, summary: text, at: new Date().toISOString() }),
      source: `task-runner:${task.id}`,
    });
    memoryKey = key;
  } catch (error) {
    console.log('[v0] task run persist failed:', error?.message);
  }

  // Deliver the outcome to the creator's inbox (broadcast when unattributed).
  let inboxId = null;
  try {
    const sent = await sendInboxMessage({
      from: 'task-runner',
      to: task.createdBy || 'broadcast',
      namespace: 'qig',
      type: 'task_result',
      subject: `Task ${ok ? 'done' : 'failed'}: ${task.title}`.slice(0, 256),
      payload: { taskId: task.id, ok, summary: text.slice(0, 4000), memoryKey, project: task.project, repository: task.repository },
    });
    inboxId = sent.id;
  } catch (error) {
    console.log('[v0] task result inbox delivery failed:', error?.message);
  }

  return { ok, summary: text, inboxId, memoryKey };
}

// Run one task by id on demand (manual "Run now"). Claims it first so it can't
// collide with the cron. Returns { ok, ... } or a skip reason.
export async function runTaskNow(id) {
  const claimed = await claimTask(id);
  if (!claimed) {
    const existing = await getTask(id);
    return { ok: false, skipped: true, reason: existing ? 'not_runnable' : 'not_found', status: existing?.status };
  }
  const result = await executeClaimed(claimed);
  const updated = await recordRun(id, result);
  return { ok: result.ok, task: updated, run: result };
}

// Drain due tasks for a cron tick. Sequential and capped so one tick can't blow
// the function budget or the credit budget.
export async function runDueTasks({ trigger = 'cron' } = {}) {
  const due = await listDueTasks();
  if (due.length === 0) return { ok: true, trigger, ran: 0, tasks: [] };

  const ran = [];
  for (const task of due.slice(0, MAX_TASKS_PER_TICK)) {
    const claimed = await claimTask(task.id);
    if (!claimed) continue; // another tick already took it
    const result = await executeClaimed(claimed);
    await recordRun(task.id, result);
    ran.push({ id: task.id, title: task.title, ok: result.ok });
  }
  return { ok: true, trigger, ran: ran.length, remaining: Math.max(0, due.length - ran.length), tasks: ran };
}
