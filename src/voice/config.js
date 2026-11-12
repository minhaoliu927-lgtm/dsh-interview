import z from '@deepseek-ai/schemastery';
import { validateRealtimeConfig, RealtimeError } from './realtime-provider.js';

/** Rendered by DSH's own plugin settings; the secret belongs to its credential service. */
export const Config = z.object({
  realtimeEnabled: z.boolean().default(false).description('启用实时语音面试 / Enable realtime voice interviews').volatile(),
  realtimeRegion: z.union(['beijing', 'singapore']).default('beijing').description('音频服务地域 / Audio service region').volatile(),
  realtimeWorkspace: z.string().default('').description('百炼业务空间 ID / Model Studio workspace ID').volatile(),
  realtimeModel: z.union(['qwen3.5-omni-plus-realtime', 'qwen3.5-omni-flash-realtime', 'qwen3.8-omni-flash-realtime'])
    .default('qwen3.5-omni-plus-realtime').description('实时音频模型 / Realtime audio model').volatile(),
  realtimeCredential: z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).role('credential-ref').default('ZHIJING_REALTIME_API_KEY')
    .description('专用音频凭据 / Dedicated audio credential').volatile(),
});
const read = value => typeof value?.get === 'function' ? value.get() : value;
export function realtimeConfig(config = {}) {
  if (read(config.realtimeEnabled) !== true) throw new RealtimeError('not-configured', '请在 DSH 插件设置中启用实时音频服务。', 409);
  return validateRealtimeConfig({ region: read(config.realtimeRegion) ?? 'beijing', workspace: read(config.realtimeWorkspace),
    model: read(config.realtimeModel) ?? 'qwen3.5-omni-plus-realtime', credentialRef: read(config.realtimeCredential) ?? 'ZHIJING_REALTIME_API_KEY' });
}

export async function realtimeCatalog(ctx, config, available = true) {
  const result = { available, configured: false, provider: 'qwen-realtime', model: read(config?.realtimeModel) ?? 'qwen3.5-omni-plus-realtime', settingsNs: 'dsh-interview' };
  try {
    const options = realtimeConfig(config);
    const credentials = ctx.get('credentials');
    if (!credentials?.describe) return { ...result, reason: 'REALTIME_CREDENTIALS_UNAVAILABLE' };
    const info = await credentials.describe(options.credentialRef);
    return { ...result, configured: Boolean(info.configured), reason: info.configured ? undefined : 'REALTIME_CREDENTIAL_REQUIRED' };
  } catch (error) { return { ...result, reason: error.code ?? 'REALTIME_NOT_CONFIGURED' }; }
}
