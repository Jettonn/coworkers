import {
  SkillResourceNotFoundError,
  SkillSourceError,
  parseSkillName,
  parseSkillResourcePath,
} from "agents/skills"
import type {
  InvalidSkill,
  ListedSkill,
  SkillListing,
  SkillSource,
} from "agents/skills"
import type { Skill } from "@/lib/types"
import { parseSkillMd } from "./skill-fetch"

/**
 * Where a bot's skills come from, for Think's `getSkills()`. Think lists
 * these before every turn.
 *
 * Neither source reads a folder. Think's workspace source would make any
 * file written there a skill on the next turn, and a bot's shell has the
 * internet, so it could fetch one in without the user seeing it.
 */

/** A skill as a bot's turn sees it: its steps and the files beside them. */
export interface BotSkill {
  name: string
  description: string
  body: string
  files: { path: string; size: number }[]
}

/** What a bot needs from the hub for the skills it may use. */
export interface InstalledSkillsPort {
  botSkills(botId: string): Promise<BotSkill[]>
  skillResource(
    botId: string,
    name: string,
    path: string
  ): Promise<string | null>
}

/** What the user installed for this bot or for every bot. Hub-side scoping. */
export function installedSkillSource(
  hub: () => Promise<InstalledSkillsPort>,
  botId: string
): SkillSource {
  const id = "installed"
  return {
    id,
    async list() {
      try {
        return {
          ok: true,
          value: toListing(await (await hub()).botSkills(botId)),
        }
      } catch (err) {
        return { ok: false, error: new SkillSourceError(id, "list", err) }
      }
    },
    async readResource(skill, path) {
      let content: string | null
      try {
        content = await (await hub()).skillResource(botId, skill, path)
      } catch (err) {
        return {
          ok: false,
          error: new SkillSourceError(id, "read-resource", err),
        }
      }
      if (content === null) {
        return { ok: false, error: new SkillResourceNotFoundError(skill, path) }
      }
      return {
        ok: true,
        value: { path, kind: resourceKind(path), encoding: "text", content },
      }
    },
  }
}

/** Skills this bot saved with save_skill. The list is its state, not a folder. */
export function learnedSkillSource(
  saved: () => Skill[],
  read: (path: string) => Promise<string | null>
): SkillSource {
  return {
    id: "learned",
    async list() {
      const found = await Promise.all(
        saved().map(async (skill): Promise<BotSkill | null> => {
          const raw = await read(learnedSkillPath(skill.slug))
          if (raw === null) return null
          return {
            name: skill.slug,
            description: skill.description,
            body: parseSkillMd(raw)?.body ?? raw,
            files: [],
          }
        })
      )
      return { ok: true, value: toListing(found.filter((s) => s !== null)) }
    },
    readResource: async (skill, path) => ({
      ok: false,
      error: new SkillResourceNotFoundError(skill, path),
    }),
  }
}

function toListing(found: BotSkill[]): SkillListing {
  const skills: ListedSkill[] = []
  const invalid: InvalidSkill[] = []
  for (const entry of found) {
    const name = parseSkillName(entry.name)
    if (!name.ok) {
      invalid.push({ location: entry.name, error: name.error })
      continue
    }
    skills.push({
      skill: {
        name: name.value,
        description: entry.description,
        body: entry.body,
        metadata: {},
        allowedTools: [],
        extraFields: {},
      },
      resources: entry.files.flatMap((file) => {
        const path = parseSkillResourcePath(file.path)
        if (!path.ok) return []
        return [
          {
            path: path.value,
            kind: resourceKind(file.path),
            encoding: "text" as const,
            size: file.size,
          },
        ]
      }),
    })
  }
  return { skills, invalid }
}

export function learnedSkillPath(slug: string) {
  return `/workspace/skills/${slug}.md`
}

/** A resource's kind, from the folders the Agent Skills format names. */
export function resourceKind(path: string) {
  if (path.startsWith("scripts/")) return "script" as const
  if (path.startsWith("references/")) return "reference" as const
  if (path.startsWith("assets/")) return "asset" as const
  return "file" as const
}
