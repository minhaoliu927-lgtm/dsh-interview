import React from 'react';

// better-sidebar components do not receive DSH's authorized renderSlot and
// SessionProvider bindings. Enter the registered native workbench instead of
// rendering a second, incomplete copy of its session-owning component.
export function mountBetterSidebar(ctx, t) {
  const register = inner => {
    const sidebar = inner.get?.('betterSidebar') || inner.betterSidebar;
    if (typeof sidebar?.registerTab !== 'function') return;
    inner.effect(() => {
      let alive = true;
      function Entry() {
        const [failed, setFailed] = React.useState(false);
        return <section style={{ padding: 24 }}><h2>{t('panel')}</h2><p>{t('deskSidebarNote')}</p><button type="button" onClick={() => {
          const layout = alive && ctx.get?.('layout');
          if (typeof layout?.selectPanel !== 'function') { setFailed(true); return; }
          layout.selectPanel('zhijing'); setFailed(false);
        }}>{t('deskOpenWorkbench')}</button>{failed && <p role="alert">{t('unavailable')}</p>}</section>;
      }
      const dispose = sidebar.registerTab({ id: 'dsh-interview-desk:workbench', title: () => t('panel'),
        description: () => t('deskSidebarNote'), order: 60, single: true, component: Entry });
      return () => { alive = false; dispose?.(); };
    }, 'zhijing: optional better-sidebar entry');
  };
  if (typeof ctx.inject === 'function') ctx.inject(['betterSidebar'], register);
  else register(ctx);
}
