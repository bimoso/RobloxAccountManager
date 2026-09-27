import { useEffect, useId, useMemo, useState } from 'react';
import { Check, KeyRound, Rocket, X } from 'lucide-react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { LaunchModal } from '@/pages/Accounts/LaunchModal';
import { useTranslation } from '@/i18n/useTranslation';
import { identityStyle } from '@/lib/identity';
import { useAccountStore } from '@/stores/accountStore';
import { useLaunchIntentStore } from '@/stores/launchIntentStore';
import { usePlaceLibraryStore } from '@/stores/placeLibraryStore';
import './LaunchModalHost.css';

/** Global launch handoff used by account actions and actionable Charts cards. */
export function LaunchModalHost(): JSX.Element | null {
  const titleId = useId();
  const intent = useLaunchIntentStore((state) => state.intent);
  const close = useLaunchIntentStore((state) => state.close);
  const accounts = useAccountStore((state) => state.accounts);
  const placeLibrary = usePlaceLibraryStore((state) => state.entries);
  const { t } = useTranslation();
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const [recalled, setRecalled] = useState(false);

  useEffect(() => {
    if (!intent) {
      setPickedIds([]);
      setRecalled(false);
      return;
    }
    if (intent.accountIds.length > 0) {
      setPickedIds(intent.accountIds);
      setRecalled(false);
      return;
    }
    // A destination with no roster attached: start from the accounts used on
    // the last launch of that game, so the usual batch is one click away.
    const remembered = intent.seed?.placeId
      ? (placeLibrary.find((entry) => entry.placeId === intent.seed?.placeId)?.lastAccountIds ?? [])
          .filter((id) => accounts.some((account) => account.id === id))
      : [];
    setPickedIds(remembered);
    setRecalled(remembered.length > 0);
    // Only a new intent should reseed the picker; a library or roster update
    // while it is open must not wipe what the user has ticked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent]);

  const launchAccounts = useMemo(
    () => accounts.filter((account) => pickedIds.includes(account.id)),
    [accounts, pickedIds],
  );

  if (!intent) return null;

  // The picker stays up until "Confirm": keying it on the picked ids made the
  // very first click jump straight into the launcher, so a batch could never
  // be assembled here.
  if (intent.accountIds.length === 0) {
    const allPicked = accounts.length > 0 && pickedIds.length === accounts.length;
    const seedTitle = intent.seed?.name || `Place ${intent.seed?.placeId ?? ''}`;
    return (
      <Modal open onClose={close} titleId={titleId} size="md">
        <section className="launch-picker">
          <header className="launch-picker__head">
            <div className="launch-picker__titles">
              <h2 id={titleId} className="fm-title">{t('host.listAria')}</h2>
              <span className="launch-picker__sub">
                {intent.seed?.privateServer ? (
                  <>
                    <KeyRound size={11} aria-hidden="true" />
                    {intent.seed.privateServer.name}
                    {' · '}
                    {seedTitle}
                  </>
                ) : (
                  seedTitle
                )}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={t('host.closeAria')}
              onClick={close}
            >
              <X size={15} aria-hidden="true" />
            </Button>
          </header>

          {accounts.length > 0 ? (
            <div className="launch-picker__bar">
              <button
                type="button"
                className="launch-picker__bulk"
                onClick={() => setPickedIds(allPicked ? [] : accounts.map((account) => account.id))}
              >
                {allPicked ? t('host.clear') : t('host.selectAll')}
              </button>
              {recalled ? (
                <span className="launch-picker__recalled">{t('host.lastUsedHint')}</span>
              ) : null}
            </div>
          ) : null}

          <div className="launch-picker__list" role="listbox" aria-label={t('host.listAria')}>
            {accounts.map((account) => {
              const selected = pickedIds.includes(account.id);
              const label = account.nickname?.trim() || account.username;
              return (
                <button
                  key={account.id}
                  type="button"
                  className="rk-row launch-picker__row"
                  role="option"
                  aria-selected={selected}
                  data-selected={selected || undefined}
                  onClick={() => setPickedIds((current) =>
                    current.includes(account.id)
                      ? current.filter((id) => id !== account.id)
                      : [...current, account.id])}
                >
                  <span className="rk-row__gutter">
                    <span className="rk-row__tick" data-on={selected || undefined} />
                  </span>
                  {/* The same identity avatar the roster draws, so the account
                      is recognised here by the colour already learned there. */}
                  <span
                    className="launch-picker__avatar acc-avatar"
                    style={identityStyle(account.userId || account.id)}
                    aria-hidden="true"
                  >
                    {(label[0] ?? '?').toUpperCase()}
                  </span>
                  <span className="rk-row__main">
                    <span className="rk-row__title">{label}</span>
                    <span className="rk-row__meta">@{account.username}</span>
                  </span>
                  <span className="launch-picker__check" aria-hidden="true">
                    {selected ? <Check size={13} /> : null}
                  </span>
                </button>
              );
            })}
            {accounts.length === 0 ? (
              <p className="launch-picker__empty">{t('host.empty')}</p>
            ) : null}
          </div>

          <footer className="launch-picker__foot">
            <span className="launch-picker__count u-num">
              {t('packages.modal.selectedCount', { count: pickedIds.length })}
            </span>
            <div className="launch-picker__actions">
              <Button variant="secondary" onClick={close}>{t('common.cancel')}</Button>
              <Button
                variant="primary"
                disabled={pickedIds.length === 0}
                onClick={() => useLaunchIntentStore.setState({
                  intent: { ...intent, accountIds: [...pickedIds] },
                })}
              >
                {t('host.continue')} <Rocket size={14} aria-hidden="true" />
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
