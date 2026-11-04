import { describe, expect, it } from "vitest"
import { loadSkillCatalog } from "agents/skills"
import type { SkillName, SkillResourcePath } from "agents/skills"
import {
  installedSkillSource,
  learnedSkillPath,
  learnedSkillSource,
  resourceKind,
} from "./skill-sources"
import type { BotSkill, InstalledSkillsPort } from "./skill-sources"

const name = (s: string) => s as SkillName
const path = (s: string) => s as SkillResourcePath

async function listed(source: ReturnType<typeof learnedSkillSource>) {
  const result = await source.list()
  if (!result.ok) throw result.error
  return result.value
}

describe("learnedSkillSource", () => {
  const skill = { slug: "report", name: "Report", description: "Weekly report" }
  const file = `---\nname: "Report"\ndescription: "Weekly report"\n---\n\n# Report\n\n1. Open it\n`

  it("lists what save_skill recorded, with the steps and no frontmatter", async () => {
    const paths: string[] = []
    const source = learnedSkillSource(
      () => [skill],
      async (p) => {
        paths.push(p)
        return file
      }
    )
    const { skills, invalid } = await listed(source)
    expect(skills.map((s) => s.skill)).toMatchObject([
      {
        name: "report",
        description: "Weekly report",
        body: "# Report\n\n1. Open it",
      },
    ])
    expect(invalid).toEqual([])
    expect(paths).toEqual([learnedSkillPath("report")])
  })

  it("leaves out a recorded skill whose file is gone", async () => {
    const source = learnedSkillSource(
      () => [skill],
      async () => null
    )
    expect((await listed(source)).skills).toEqual([])
  })

  it("has no bundled files", async () => {
    const source = learnedSkillSource(
      () => [skill],
      async () => file
    )
    const result = await source.readResource(name("report"), path("notes.md"))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error._tag).toBe("SkillResourceNotFoundError")
  })
})

describe("installedSkillSource", () => {
  const installed: BotSkill = {
    name: "one",
    description: "Use it",
    body: "Do the thing",
    files: [{ path: "references/a.md", size: 3 }],
  }

  function hubWith(port: Partial<InstalledSkillsPort>) {
    const full: InstalledSkillsPort = {
      botSkills: async () => [],
      skillResource: async () => null,
      ...port,
    }
    return async () => full
  }

  it("lists what the hub gives this bot, with its files", async () => {
    const asked: string[] = []
    const source = installedSkillSource(
      hubWith({
        botSkills: async (botId) => {
          asked.push(botId)
          return [installed]
        },
      }),
      "b1"
    )
    const { skills } = await listed(source)
    expect(asked).toEqual(["b1"])
    expect(skills).toMatchObject([
      {
        skill: { name: "one", description: "Use it", body: "Do the thing" },
        resources: [
          {
            path: "references/a.md",
            kind: "reference",
            encoding: "text",
            size: 3,
          },
        ],
      },
    ])
  })

  it("reports a skill whose name breaks the spec instead of listing it", async () => {
    const source = installedSkillSource(
      hubWith({ botSkills: async () => [{ ...installed, name: "Bad Name" }] }),
      "b1"
    )
    const { skills, invalid } = await listed(source)
    expect(skills).toEqual([])
    expect(invalid).toHaveLength(1)
  })

  it("returns a source error when the hub cannot be reached", async () => {
    const source = installedSkillSource(
      hubWith({
        botSkills: async () => {
          throw new Error("hub down")
        },
      }),
      "b1"
    )
    const result = await source.list()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error._tag).toBe("SkillSourceError")
  })

  it("reads a bundled file, or says it is not there", async () => {
    const source = installedSkillSource(
      hubWith({
        skillResource: async (_bot, _skill, p) =>
          p === "references/a.md" ? "abc" : null,
      }),
      "b1"
    )
    expect(
      await source.readResource(name("one"), path("references/a.md"))
    ).toEqual({
      ok: true,
      value: {
        path: "references/a.md",
        kind: "reference",
        encoding: "text",
        content: "abc",
      },
    })
    const missing = await source.readResource(name("one"), path("nope.md"))
    expect(missing.ok).toBe(false)
    if (!missing.ok)
      expect(missing.error._tag).toBe("SkillResourceNotFoundError")
  })
})

describe("both sources in Think's catalog", () => {
  it("lists, activates and reads skills the way a bot turn does", async () => {
    let hubUp = true
    const learned = learnedSkillSource(
      () => [{ slug: "report", name: "Report", description: "Weekly report" }],
      async () =>
        "---\nname: Report\ndescription: Weekly report\n---\n\nOpen it"
    )
    const installed = installedSkillSource(async () => {
      if (!hubUp) throw new Error("hub down")
      return {
        botSkills: async () => [
          {
            name: "one",
            description: "Use it",
            body: "Do the thing",
            files: [{ path: "references/a.md", size: 3 }],
          },
        ],
        skillResource: async () => "abc",
      }
    }, "b1")
    const sources = [learned, installed]

    const catalog = await loadSkillCatalog(sources)
    expect(catalog.diagnostics).toEqual([])
    expect(catalog.prompt()).toContain("report")
    expect(catalog.prompt()).toContain("Use it")
    const activated = catalog.activate("one")
    expect(activated.ok && activated.value).toContain("Do the thing")
    const read = await catalog.readResource({ path: "one/references/a.md" })
    expect(read.ok && read.value.resource.content).toBe("abc")

    hubUp = false
    const after = await loadSkillCatalog(sources, { previous: catalog })
    expect(after.find("one")).toBeDefined()
    expect(after.diagnostics).toMatchObject([
      { _tag: "SourceFailed", sourceId: "installed", keptPrevious: true },
    ])
  })
})

describe("resourceKind", () => {
  it("goes by the folder", () => {
    expect(resourceKind("scripts/run.js")).toBe("script")
    expect(resourceKind("references/a.md")).toBe("reference")
    expect(resourceKind("assets/a.txt")).toBe("asset")
    expect(resourceKind("notes.md")).toBe("file")
  })
})
