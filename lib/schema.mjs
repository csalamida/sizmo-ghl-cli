// lib/schema.mjs — walk registry loaders, read each command's meta, emit a JSON manifest.
export async function buildSchema(registry, exitCodes) {
  const commands = [];
  for (const [name, loader] of Object.entries(registry)) {
    const mod = await loader();
    if (mod?.meta) commands.push(mod.meta);
  }
  return { schemaVersion: 1, commands, exitCodes };
}
