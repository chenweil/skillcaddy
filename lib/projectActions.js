import { syncClaudeSkills } from './claudeStore.js';
import { enableSkill } from './skillStore.js';

export async function enableProjectSkill(rootDir, input) {
  const result = await enableSkill(rootDir, input);

  if (result.scope !== 'project') return result;

  return {
    ...result,
    claudeSync: await syncClaudeBestEffort(input.projectPath)
  };
}

async function syncClaudeBestEffort(projectPath) {
  try {
    return await syncClaudeSkills(projectPath);
  } catch (error) {
    return {
      ok: false,
      error: error.message || 'Claude Code 同步失败'
    };
  }
}
