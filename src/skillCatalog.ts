import fs from 'node:fs';
import path from 'node:path';

export type SkillSummary = {
  id: string;
  name: string;
  summary: string;
  best_for: string;
};

export type SelectedSkill = {
  id?: string;
  name: string;
  reason: string;
  summary?: string;
  sop?: string;
  trace_note?: string;
};

type SkillDocument = SkillSummary & {
  content: string;
  sop: string;
  trace_note: string;
};

function parseSkillFile(filePath: string): SkillDocument {
  const content = fs.readFileSync(filePath, 'utf8');
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatter) throw new Error(`Skill file is missing frontmatter: ${filePath}`);

  const metadata = Object.fromEntries(
    frontmatter[1]
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(':');
        if (separator === -1) throw new Error(`Invalid skill metadata line in ${filePath}: ${line}`);
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      })
  );

  const body = frontmatter[2].trim();
  const sop = body.match(/## SOP\n([\s\S]*?)(?:\n## |$)/)?.[1]?.trim() ?? '';
  const traceNote = body.match(/## Trace note\n([\s\S]*?)(?:\n## |$)/)?.[1]?.trim() ?? '';

  return {
    id: metadata.id,
    name: metadata.name,
    summary: metadata.summary,
    best_for: metadata.best_for,
    content: body,
    sop,
    trace_note: traceNote
  };
}

let cachedSkills: SkillDocument[] | undefined;

export function loadSkillCatalog() {
  if (cachedSkills) return cachedSkills;

  const skillsDir = path.join(process.cwd(), 'skills');
  cachedSkills = fs.readdirSync(skillsDir)
    .filter((fileName) => fileName.endsWith('.md'))
    .sort()
    .map((fileName) => parseSkillFile(path.join(skillsDir, fileName)));

  return cachedSkills;
}

export function getSkillSummaries(): SkillSummary[] {
  return loadSkillCatalog().map(({ id, name, summary, best_for }) => ({
    id,
    name,
    summary,
    best_for
  }));
}

export function formatSkillIndexForPlanner() {
  return getSkillSummaries()
    .map((skill) => `- ${skill.id}: ${skill.name} - ${skill.summary} Best for: ${skill.best_for}.`)
    .join('\n');
}

export function hydrateSelectedSkills(selectedSkills: SelectedSkill[]): SelectedSkill[] {
  const catalog = loadSkillCatalog();

  return selectedSkills.map((selectedSkill) => {
    const skill = catalog.find((candidate) => candidate.id === selectedSkill.id)
      ?? catalog.find((candidate) => candidate.name.toLowerCase() === selectedSkill.name.toLowerCase());

    if (!skill) return selectedSkill;

    return {
      id: skill.id,
      name: skill.name,
      reason: selectedSkill.reason,
      summary: skill.summary,
      sop: skill.sop,
      trace_note: skill.trace_note
    };
  });
}

export function formatSelectedSkillSops(selectedSkills: SelectedSkill[]) {
  return hydrateSelectedSkills(selectedSkills)
    .filter((skill) => skill.sop)
    .map((skill) => `## ${skill.name}\nReason selected: ${skill.reason}\n\nSOP:\n${skill.sop}`)
    .join('\n\n');
}
