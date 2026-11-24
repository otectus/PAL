/** Starting points for a document: plain Markdown with places to fill in. They are text, not programs. */
export type Template = { id: string; name: string; purpose: string; body: string };
export const templates: Template[] = [
  { id: 'report', name: 'Report', purpose: 'Findings with their evidence and what to do next', body: '# {{title}}\n\n_{{date}}_\n\n## Summary\n\nWhat this found, in two or three sentences.\n\n## Background\n\n\n## Findings\n\n1. \n\n## Evidence\n\n| Finding | Source | Confidence |\n| --- | --- | --- |\n|  |  |  |\n\n## Limits\n\nWhat was not checked, and what could change the conclusion.\n\n## Next steps\n\n- [ ] \n' },
  { id: 'decision', name: 'Decision record', purpose: 'One decision, the options considered and why', body: '# {{title}}\n\n- Date: {{date}}\n- Status: proposed\n- Project: {{project}}\n\n## Context\n\n\n## Options considered\n\n### Option A\n\n### Option B\n\n## Decision\n\n\n## Consequences\n\n- \n' },
  { id: 'meeting', name: 'Meeting notes', purpose: 'Who met, what was decided and who does what', body: '# {{title}}\n\n- Date: {{date}}\n- Present: \n\n## Agenda\n\n1. \n\n## Notes\n\n\n## Decisions\n\n- \n\n## Actions\n\n| Action | Who | By |\n| --- | --- | --- |\n|  |  |  |\n' },
  { id: 'comparison', name: 'Comparison', purpose: 'Alternatives side by side on the same criteria', body: '# {{title}}\n\n_{{date}}_\n\n## Criteria\n\n1. \n\n## Comparison\n\n| Criterion | Option A | Option B |\n| --- | --- | --- |\n|  |  |  |\n\n## Recommendation\n\n\n## What would change it\n\n- \n' },
  { id: 'status', name: 'Project status', purpose: 'Progress, problems and plans for {{project}}', body: '# {{title}}\n\n_{{project}} · {{date}}_\n\n## Done\n\n- \n\n## In progress\n\n- \n\n## Problems\n\n- \n\n## Next\n\n- [ ] \n' },
];
export function fillTemplate(id: string, values: { title: string; date: string; project: string }) {
  const template = templates.find(item => item.id === id);
  if (!template) throw new Error('Choose one of the document templates');
  const line = (text: string) => text.replace(/[\r\n]+/g, ' ').trim();
  return template.body.replace(/\{\{(title|date|project)\}\}/g, (_whole, key: 'title' | 'date' | 'project') => line(values[key]) || (key === 'project' ? 'No project' : ''));
}
