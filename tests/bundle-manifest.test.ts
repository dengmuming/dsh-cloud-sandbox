import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dockerShellPlugin, dockerSubprocessPlugin, sandboxFileIntakePlugin } from '../src/index.ts'

const ROOT = resolve(import.meta.dirname, '..')

describe('DSH plugin bundle manifest', () => {
  it('declares valid dsh.bundle, exports, icon, engines.dsh, and localized metadata', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      name: string
      icon?: string
      engines?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
      exports?: Record<string, unknown>
      files?: string[]
      peerDependencies?: Record<string, string>
    }

    expect(pkg.name).toBe('dsh-cloud-sandbox')
    expect(pkg.engines?.dsh).toBe('>=0.2.1-rc.2 <1.0.0')
    expect(pkg.peerDependencies?.['@deepseek-ai/cordis']).toBe('^4.0.5')
    expect(pkg.peerDependencies?.['@deepseek-ai/schemastery']).toBe('^3.18.5')
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(pkg.exports?.['./intake']).toBeDefined()
    expect(pkg.exports?.['./cordis.patch.yml']).toBe('./cordis.patch.yml')
    expect(pkg.exports?.['./locale/*.json']).toBe('./locale/*.json')
    expect(pkg.exports?.['./package.json']).toBe('./package.json')
    expect(pkg.files).toContain('cordis.patch.yml')
    expect(pkg.files).toContain('icon.svg')
    expect(pkg.files).toContain('locale/*.json')
    expect(pkg.files).toContain('deploy')

    // Patch file exists, disables local capability providers, inserts sandbox providers,
    // and leaves surface-owned tool rows (tool-bash/tool-pwsh) untouched so web/desktop presets stay isolated.
    const patchPath = join(ROOT, pkg.dsh!.bundle!.patch!)
    expect(existsSync(patchPath)).toBe(true)
    const patchText = readFileSync(patchPath, 'utf8')
    expect(patchText).toContain("name: 'dsh-cloud-sandbox/subprocess'")
    expect(patchText).toContain("name: 'dsh-cloud-sandbox/shell'")
    expect(patchText).toContain("name: 'dsh-cloud-sandbox/intake'")
    expect(patchText).toContain('id: subprocess')
    expect(patchText).toContain('id: bash-sandbox')
    expect(patchText).toContain('id: pwsh-sandbox')
    expect(patchText).toContain('DSH_SANDBOX_CLOUD_MODE')
    expect(patchText).toContain('DSH_SANDBOX_NETWORK_MODE')
    expect(patchText).toContain('mountAttachments: false')
    expect(patchText).toContain('stageSessionAttachments: true')
    expect(patchText).not.toContain('id: tool-bash')
    expect(patchText).not.toContain('id: tool-pwsh')

    // Cloud No-LAN public egress deploy scripts and Dockerfile pip3/Python runtime exist and enforce isolation.
    const setupScript = readFileSync(join(ROOT, 'deploy/setup-public-egress-network.sh'), 'utf8')
    expect(setupScript).toContain('enable_icc=false')
    expect(setupScript).toContain('169.254.0.0/16')
    expect(setupScript).toContain('10.0.0.0/8')
    expect(setupScript).toContain('172.16.0.0/12')
    expect(setupScript).toContain('192.168.0.0/16')
    expect(existsSync(join(ROOT, 'deploy/teardown-public-egress-network.sh'))).toBe(true)
    expect(existsSync(join(ROOT, 'deploy/README.md'))).toBe(true)

    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
    expect(dockerfile).toContain('python3-pip')
    expect(dockerfile).toContain('pymupdf')
    expect(dockerfile).toContain('openpyxl')
    expect(dockerfile).toContain('PYTHONUSERBASE=/tmp/.local')

    // All bundle plugins expose Schemastery Config schemas for DSH Settings UI.
    expect(dockerSubprocessPlugin.Config).toBeDefined()
    expect(dockerShellPlugin.Config).toBeDefined()
    expect(sandboxFileIntakePlugin.Config).toBeDefined()

    // Icon exists and fits DSH's 256 KiB bound.
    expect(pkg.icon).toBe('./icon.svg')
    const iconStat = statSync(join(ROOT, 'icon.svg'))
    expect(iconStat.isFile()).toBe(true)
    expect(iconStat.size).toBeLessThan(256 * 1024)

    // English and Chinese locale metadata follow DSH package-meta format.
    for (const file of ['locale/en.json', 'locale/zh.json']) {
      const locale = JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as {
        meta?: { title?: string; description?: string }
      }
      expect(typeof locale.meta?.title).toBe('string')
      expect(locale.meta!.title!.trim().length).toBeGreaterThan(0)
      expect(typeof locale.meta?.description).toBe('string')
      expect(locale.meta!.description!.trim().length).toBeGreaterThan(0)
    }
  })
})
