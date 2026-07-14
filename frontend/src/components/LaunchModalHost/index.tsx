import { useEffect, useId, useMemo, useState } from 'react';
import { Check, Rocket, UserRound, X } from 'lucide-react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { LaunchModal } from '@/pages/Accounts/LaunchModal';
import { useAccountStore } from '@/stores/accountStore';
import { useLaunchIntentStore } from '@/stores/launchIntentStore';
import './LaunchModalHost.css';

/** Global launch handoff used by account actions and actionable Charts cards. */
export function LaunchModalHost(): JSX.Element | null {
  const titleId = useId();
  const intent = useLaunchIntentStore((state) => state.intent);
  const close = useLaunchIntentStore((state) => state.close);
  const accounts = useAccountStore((state) => state.accounts);
  const [pickedIds, setPickedIds] = useState<string[]>([]);

  useEffect(() => {
    setPickedIds(intent?.accountIds ?? []);
  }, [intent]);

  const launchAccounts = useMemo(
    () => accounts.filter((account) => pickedIds.includes(account.id)),
    [accounts, pickedIds],
  );

  if (!intent) return null;

  if (intent.accountIds.length === 0 && launchAccounts.length === 0) {
    return (
      <Modal open onClose={close} titleId={titleId}>
        <section className="launch-picker">
          <header className="launch-picker__header">
            <span className="launch-picker__glyph"><Rocket size={19} /></span>
            <div>
              <span>Charts / route handoff</span>
              <h2 id={titleId}>Elige quién entra</h2>
              <p>
                {intent.seed?.name || `Place ${intent.seed?.placeId ?? ''}`}
              </p>
            </div>
            <button type="button" aria-label="Cerrar" onClick={close}><X size={17} /></button>
          </header>

          <div className="launch-picker__accounts" role="listbox" aria-label="Cuentas para lanzar">
            {accounts.map((account) => {
              const selected = pickedIds.includes(account.id);
              return (
                <button
                  key={account.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-selected={selected || undefined}
                  onClick={() => setPickedIds((current) =>
                    current.includes(account.id)
                      ? current.filter((id) => id !== account.id)
                      : [...current, account.id])}
                >
                  <span className="launch-picker__avatar"><UserRound size={16} /></span>
                  <span><strong>{account.nickname?.trim() || account.username}</strong><small>@{account.username}</small></span>
                  <span className="launch-picker__check">{selected ? <Check size={13} /> : null}</span>
                </button>
              );
            })}
            {accounts.length === 0 ? (
              <p className="launch-picker__empty">Guarda al menos una cuenta para lanzar esta experiencia.</p>
            ) : null}
          </div>

          <footer className="launch-picker__footer">
            <span>{pickedIds.length ? `${pickedIds.length} seleccionada${pickedIds.length === 1 ? '' : 's'}` : 'Sin selección'}</span>
            <div>
              <Button variant="secondary" onClick={close}>Cancelar</Button>
              <Button
                variant="primary"
                disabled={pickedIds.length === 0}
                onClick={() => useLaunchIntentStore.setState({
                  intent: { ...intent, accountIds: [...pickedIds] },
                })}
              >
                Continuar <Rocket size={15} />
              </Button>
            </div>
          </footer>
        </section>
      </Modal>
    );
  }

  return (
    <LaunchModal
      open={launchAccounts.length > 0}
      accounts={launchAccounts}
      seed={intent.seed}
      onClose={close}
      onLaunched={(accountId) => {
        useAccountStore.setState((state) => ({
          accounts: state.accounts.map((account) =>
            account.id === accountId
              ? { ...account, launchedInstanceCount: (account.launchedInstanceCount ?? 0) + 1 }
              : account,
          ),
        }));
      }}
    />
  );
}
