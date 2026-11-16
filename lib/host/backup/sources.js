/**
 * Backup sources: the things a backup can contain.
 *
 * A source is a small descriptor plus a collector, so the engine never hardcodes
 * filesystem knowledge and a future source can be added without touching the
 * archive or destination layers.
 *
 * Every collector reports what it actually found instead of assuming success.
 * A missing directory is a normal state (a profile may not use a feature), so it
 * yields zero entries rather than an error that aborts the whole backup.
 */
import { stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Read an installed bundle's identity for the plugin manifest section. */
async function readBundleManifest(nodeModules, name) {
  try {
    const text = await (await import('node:fs/promises')).readFile(join(nodeModules, name, 'package.json'), 'utf8');
    const parsed = JSON.parse(text);
    return { name: parsed.name ?? name, version: parsed.version ?? null, description: parsed.description ?? null };
  } catch {
    return { name, version: null, description: null };
  }
}

/**
 * Build the source table for one profile.
 *
 * `dshHome` is resolved once by the caller so every source agrees on which home
 * a backup describes — reading the environment again per source could describe
 * two different installations in one archive.
 */
export function createSources({ dshHome, profileName, logger }) {
  const profileDir = join(dshHome, 'profiles', profileName);
  const nodeModules = join(profileDir, 'node_modules');

  return {
    workspaces: {
      label: 'Workspaces',
      async roots() {
        const dir = join(dshHome, 'workspaces');
        const info = await stat(dir).catch(() => undefined);
        return info?.isDirectory() === true ? [dir] : [];
      },
      exclude: [],
    },

    conversations: {
      label: 'Conversations',
      async roots() {
        // Session logs live under the profile; a bare `sessions` dir and the
        // nested store are both valid layouts across DSH versions.
        const candidates = [join(profileDir, 'sessions'), join(dshHome, 'sessions')];
        const found = [];
        for (const dir of candidates) {
          const info = await stat(dir).catch(() => undefined);
          if (info?.isDirectory() === true) found.push(dir);
        }
        return found;
      },
      exclude: [],
    },

    systemConfig: {
      label: 'System configuration',
      async files() {
        // Settings are individual documents, so collect them by name rather than
        // copying the whole home (which would sweep up caches and secrets).
        const out = [];
        for (const name of ['config.json', 'settings.json', 'state.json', 'models.json']) {
          const file = join(dshHome, name);
          const info = await stat(file).catch(() => undefined);
          if (info?.isFile() === true) out.push(file);
        }
        const profileConfig = join(profileDir, 'cordis.patch.yml');
        const profilePackage = join(profileDir, 'package.json');
        for (const file of [profileConfig, profilePackage]) {
          const info = await stat(file).catch(() => undefined);
          if (info?.isFile() === true) out.push(file);
        }
        return out;
      },
    },

    plugins: {
      label: 'Plugins and their configuration',
      async roots() {
        const info = await stat(nodeModules).catch(() => undefined);
        return info?.isDirectory() === true ? [nodeModules] : [];
      },
      exclude: [],
      async manifest() {
        const names = await readdir(nodeModules).catch(() => []);
        const bundles = [];
        for (const name of names) {
          if (name.startsWith('.') || name.startsWith('@')) continue;
          bundles.push(await readBundleManifest(nodeModules, name));
        }
        // Scoped packages live one level deeper and are common for plugins.
        for (const name of names) {
          if (!name.startsWith('@')) continue;
          const scoped = await readdir(join(nodeModules, name)).catch(() => []);
          for (const child of scoped) {
            if (child.startsWith('.')) continue;
            bundles.push(await readBundleManifest(join(nodeModules, name), child));
          }
        }
        return bundles;
      },
    },

    extras: {
      label: 'Other data',
      async roots() {
        // The plugin's own data plus agent scratch space: everything a user
        // would miss that the four categories above do not already cover.
        const candidates = [join(dshHome, 'mydsh'), join(dshHome, 'skills'), join(dshHome, 'agents')];
        const found = [];
        for (const dir of candidates) {
          const info = await stat(dir).catch(() => undefined);
          if (info?.isDirectory() === true) found.push(dir);
        }
        return found;
      },
      exclude: [],
    },

    models: {
      label: 'Model and provider information',
      async files() {
        // Credentials are deliberately excluded: they are secrets and belong in
        // the credential store, not in an archive that may land on remote disk.
        const out = [];
        for (const name of ['llm.json', 'providers.json', 'models.json']) {
          const file = join(dshHome, name);
          const info = await stat(file).catch(() => undefined);
          if (info?.isFile() === true) out.push(file);
        }
        return out;
      },
      async descriptors() {
        return { note: 'credentials are intentionally excluded from backups' };
      },
    },
  };
}

/** Human-readable size accounting so a dry run can show what a backup holds. */
export async function measureRoots(roots, walk) {
  let bytes = 0;
  let files = 0;
  for (const root of roots) {
    const listed = await walk(root);
    files += listed.length;
    for (const file of listed) {
      const info = await stat(file).catch(() => undefined);
      if (info?.isFile() === true) bytes += info.size;
    }
  }
  return { bytes, files };
}
