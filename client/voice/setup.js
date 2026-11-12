/** Enable only the official, already available bundle after an explicit user action. */
export const DSH_VOICE_BUNDLE = '@deepseek-ai/dsh-experimental-voice-input-bundle';

export async function enableDshVoice({ getManager, openSettings, signal }) {
  try {
    signal?.throwIfAborted();
    const manager = getManager();
    if (typeof manager?.listBundles !== 'function' || typeof manager?.setBundleEnabled !== 'function') return { status: 'unavailable' };
    const inventory = await manager.listBundles();
    signal?.throwIfAborted();
    if (!inventory?.ok || !Array.isArray(inventory.value)) return { status: 'failed' };
    const bundle = inventory.value.find(row => row.name === DSH_VOICE_BUNDLE);
    // `installed` means a profile dependency. Shipped optional bundles normally
    // have installed:false and availability:installation, and can be enabled.
    if (!bundle || !['installation', 'profile'].includes(bundle.availability)) return { status: 'missing' };
    if (bundle.error || bundle.readOnlyReason) return { status: 'failed' };
    signal?.throwIfAborted();
    const result = await manager.setBundleEnabled(DSH_VOICE_BUNDLE, true);
    signal?.throwIfAborted();
    if (!result?.ok || result.value?.error || result.value?.target !== DSH_VOICE_BUNDLE || result.value.enabled !== true) return { status: 'failed' };
    if (result.value.application === 'restart-required') return { status: 'restart-required' };
    if (result.value.application === 'overridden') return { status: 'overridden' };
    if (result.value.application !== 'applied') return { status: 'failed' };
    // Preparation is Host-owned and stays on the official page. Enabling does
    // not download models, prepare a worker, configure providers, or record.
    let opened = false;
    try { opened = Boolean(openSettings?.()); } catch { /* Enablement succeeded even if navigation is unavailable. */ }
    return { status: opened ? 'applied' : 'applied-no-navigation' };
  } catch {
    signal?.throwIfAborted();
    // Do not render remote diagnostics that can contain local paths or settings.
    return { status: 'failed' };
  }
}

export function voiceSetupMessage(status) {
  return ({ enabling: 'voiceEnabling', applied: 'voiceEnabled', 'applied-no-navigation': 'voiceEnabledNoNavigation',
    'restart-required': 'voiceEnableRestart', overridden: 'voiceEnableOverridden', missing: 'voiceBundleMissing',
    unavailable: 'voiceManagerUnavailable', failed: 'voiceEnableFailed' })[status] ?? 'voiceEnableNote';
}
