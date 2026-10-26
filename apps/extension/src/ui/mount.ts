import { DEFAULT_REPLY_DELAY_SECONDS } from '@envoy/contracts';
import { checkBackendHealth } from '../messaging';
import styles from './styles.css?inline';

// A small window mounted inside Messenger, isolated from page styles.
export function mountEnvoyUi(): HTMLElement {
  const host = document.createElement('envoy-root');
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = styles;

  const container = document.createElement('div');
  // Static placeholder markup only. Never interpolate conversation/user text here.
  container.innerHTML = `
    <section aria-labelledby="envoy-goal-title">
      <h2 id="envoy-goal-title">Envoy goal setup</h2>
      <p>Placeholder only. Chat automation is not implemented.</p>
      <label for="envoy-goal">Goal</label>
      <textarea id="envoy-goal" placeholder="Your goal will go here" disabled></textarea>
      <button type="button" disabled>Start task</button>
    </section>
    <section aria-labelledby="envoy-controls-title">
      <h2 id="envoy-controls-title">Agent controls</h2>
      <p>Inactive. Reply delay: ${DEFAULT_REPLY_DELAY_SECONDS}s. No countdown is running.</p>
      <div class="controls">
        <button type="button" disabled>Send now</button>
        <button type="button" disabled>Edit</button>
        <button type="button" disabled>Cancel</button>
        <button type="button" disabled>Pause</button>
        <button type="button" disabled>Take over</button>
      </div>
      <button type="button" id="envoy-health">Check backend health</button>
      <p id="envoy-status" role="status">Backend not checked.</p>
    </section>
  `;

  const healthButton = container.querySelector<HTMLButtonElement>('#envoy-health')!;
  const status = container.querySelector<HTMLElement>('#envoy-status')!;
  healthButton.addEventListener('click', async () => {
    healthButton.disabled = true;
    status.textContent = 'Checking backend...';
    try {
      const reply = await checkBackendHealth();
      status.textContent = reply.ok ? 'Backend healthy.' : 'Backend unavailable.';
    } catch {
      status.textContent = 'Extension connection unavailable. Reload Messenger.';
    } finally {
      healthButton.disabled = false;
    }
  });

  shadow.append(style, container);
  document.body.append(host);
  return host;
}
