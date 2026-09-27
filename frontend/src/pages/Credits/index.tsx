// pages/Credits/index.tsx
//
// Credits page (design.md → Requisito 24). A static listing of the people
// behind RAM (Roblox Account Manager), ported from the Legacy_Frontend
// (the retired `#page-credits` view).
//
// Each contributor is shown with their role, name and external links
// (Requisito 24.1). External links do NOT navigate inside the webview: every
// link click invokes the `open_external` IPC command with the exact URL via
// `ipc.openExternal` and prevents the default anchor navigation
// (Requisito 24.2). This page imports nothing from other `pages/` folders
// (Requisito 1.1).
//
// The page pairs an "about RAM" card (mark, name, what the app is) with one
// card per contributor: banner, overlapping profile avatars, role and external
// links. The animated banner is swapped for a flat surface under
// `prefers-reduced-motion` — a GIF cannot be paused from CSS, so the decision
// is made in JS.

import type { MouseEvent } from 'react';
import { useState, useEffect } from 'react';
import { useReducedMotion } from 'framer-motion';
import { ExternalLink } from 'lucide-react';
import { RamLogo } from '@/components/Brand';
import { ipc } from '@/lib/ipc';
import { createKeyedSessionCache } from '@/lib/sessionCache';
import type { MessageKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import './Credits.css';

/** A single external link shown on a contributor card. */
interface CreditLink {
  /** Which brand icon to render next to the label. */
  readonly icon: 'discord' | 'github' | 'roblox';
  /** The visible label (e.g. the handle). */
  readonly label: string;
  /** The exact URL passed to `open_external` (never altered). */
  readonly url: string;
  /** Accessible title/tooltip for the link. */
  readonly title: string;
}

/** A person credited on the Credits page. */
interface Contributor {
  /** Single-letter avatar glyph shown when the remote avatar is unavailable. */
  readonly avatar: string;
  /** Message key for the role label shown under the name. */
  readonly role: MessageKey;
  /** Display name. */
  readonly name: string;
  /** Roblox user ID for fetching their avatar dynamically. */
  readonly robloxId?: string;
  /** Discord user ID for fetching their avatar dynamically. */
  readonly discordId?: string;
  /** External links for this contributor. */
  readonly links: readonly CreditLink[];
}

/**
 * The contributors shown on the Credits page.
 */
const CONTRIBUTORS: readonly Contributor[] = [
  {
    avatar: 'B',
    role: 'credits.role.lead',
    name: 'Bimo',
    robloxId: '9889370526',
    discordId: '649501821072834580',
    links: [
      {
        icon: 'discord',
        label: 'bimosk',
        url: 'https://discord.com/users/bimosk',
        title: 'Discord: bimosk',
      },
      {
        icon: 'github',
        label: 'bimoso',
        url: 'https://github.com/bimoso',
        title: 'GitHub: bimoso',
      },
      {
        icon: 'roblox',
        label: 'Bimos0o',
        url: 'https://www.roblox.com/users/9889370526/profile',
        title: 'Roblox: Bimos0o',
      },
    ],
  },
];

/** Stable Discord CDN avatars keyed by Discord user id, never display name. */
const DISCORD_AVATARS_BY_ID: Readonly<Record<string, string>> = {
  '649501821072834580':
    'https://cdn.discordapp.com/avatars/649501821072834580/1bcb4830c974a6935779ace169d055ad.png?size=256',
};

/** Brand glyphs for the supported external-link icons. */
const LINK_ICON_PATHS: Record<CreditLink['icon'], string> = {
  discord:
    'M20.317 4.369A19.791 19.791 0 0 0 15.885 3c-.22.4-.446.938-.611 1.362a18.27 18.27 0 0 0-5.548 0A8.13 8.13 0 0 0 9.114 3a19.736 19.736 0 0 0-4.432 1.369C1.865 8.106 1.11 11.749 1.343 15.339a19.9 19.9 0 0 0 5.993 3.03c.483-.66.914-1.363 1.284-2.104a12.9 12.9 0 0 1-2.023-.976c.17-.125.336-.256.497-.393a14.13 14.13 0 0 0 12.012 0c.163.14.328.27.497.393-.643.383-1.322.71-2.027.978.37.74.8 1.443 1.283 2.103a19.876 19.876 0 0 0 5.997-3.03c.276-4.156-.734-7.766-3.538-10.97zM8.802 13.502c-.98 0-1.783-.896-1.783-1.995 0-1.1.782-1.996 1.783-1.996 1.011 0 1.813.906 1.783 1.996 0 1.099-.782 1.995-1.783 1.995zm6.396 0c-.98 0-1.783-.896-1.783-1.995 0-1.1.782-1.996 1.783-1.996 1.011 0 1.813.906 1.783 1.996 0 1.099-.772 1.995-1.783 1.995z',
  github:
    'M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.38 7.86 10.9.57.1.78-.25.78-.55 0-.27-.01-1.17-.02-2.12-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.75 2.69 1.25 3.35.95.1-.75.4-1.25.72-1.54-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.24 2.76.12 3.05.74.81 1.18 1.84 1.18 3.1 0 4.43-2.7 5.41-5.27 5.7.42.36.78 1.06.78 2.14 0 1.55-.01 2.79-.01 3.17 0 .3.21.66.79.55A10.52 10.52 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z',
  roblox:
    'M18.926 23.998 0 18.892 5.075.002 24 5.108ZM15.348 10.09l-5.282-1.453-1.414 5.273 5.282 1.453z',
};

/**
 * Resolved Roblox avatar URLs keyed by contributor name, kept across unmounts
 * so re-entering Credits paints the real avatars immediately instead of
 * re-hitting the thumbnails API on every visit.
 */
const robloxAvatarCache = createKeyedSessionCache<string, string>();

/**
 * The Credits page. Renders every contributor with role, name and external
 * links. Dynamically pulls avatars from Roblox on mount (via Tauri bridge)
 * and sets robust static fallback for Discord to avoid CORS.
 */
export function CreditsPage(): JSX.Element {
  const { t } = useTranslation();
  // `useReducedMotion` can return null before the media query resolves; treat
  // that as "motion allowed" so the banner is not needlessly suppressed.
  const reducedMotion = useReducedMotion() ?? false;
  const [failedDiscordAvatars, setFailedDiscordAvatars] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [failedRobloxAvatars, setFailedRobloxAvatars] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [robloxAvatars, setRobloxAvatars] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {
      Bimo: 'https://tr.rbxcdn.com/30DAY-AvatarHeadshot-085CDD34A4FD1FF80594B29A20A3C513-Png/150/150/AvatarHeadshot/Png/isCircular',
    };
    for (const contributor of CONTRIBUTORS) {
      const cachedUrl = robloxAvatarCache.get(contributor.name);
      if (cachedUrl) initial[contributor.name] = cachedUrl;
    }
    return initial;
  });

  useEffect(() => {
    CONTRIBUTORS.forEach((contributor) => {
      // Fetch Roblox profile photo via Tauri bridge (No CORS). A cached URL
      // from a previous visit is already on screen — skip the re-fetch.
      if (contributor.robloxId && !robloxAvatarCache.get(contributor.name)) {
        ipc.getAvatarThumbnails([contributor.robloxId])
          .then((res) => {
            const item = res?.data?.[0];
            if (item?.imageUrl) {
              robloxAvatarCache.set(contributor.name, item.imageUrl);
              setRobloxAvatars((prev) => ({
                ...prev,
                [contributor.name]: item.imageUrl,
              }));
            }
          })
          .catch((err) =>
            console.error(`Error fetching Roblox thumbnail via Tauri for ${contributor.name}:`, err)
          );
      }
    });
  }, []);

  const handleLinkClick = (event: MouseEvent<HTMLAnchorElement>, url: string): void => {
    event.preventDefault();
    void ipc.openExternal(url);
  };

  return (
    <div className="rk-page">
      <header className="rk-page__head">
        <div className="rk-page__titles">
          <h1>{t('credits.title')}</h1>
          <span className="rk-page__sub">{t('credits.subtitle')}</span>
        </div>
      </header>

      <div className="rk-page__body rk-page__body--pad cr-body">
        <div className="cr-stack">
          <section className="rk-panel cr-about" aria-label={t('credits.aboutAria')}>
            <RamLogo size={56} />
            <div className="cr-about__text">
              <h2 className="cr-about__name">RAM</h2>
              <span className="cr-about__full">Roblox Account Manager</span>
              <p className="cr-about__copy">{t('credits.aboutCopy')}</p>
            </div>
          </section>

          {CONTRIBUTORS.map((contributor) => (
            <section
              className="rk-panel cr-panel"
              key={`${contributor.role}-${contributor.name}`}
            >
              {/* Banner. Flat surface instead of the GIF under reduced motion. */}
              <div
                className="cr-banner"
                data-static={reducedMotion ? '' : undefined}
                aria-hidden="true"
              />

              {/* Identity: overlapping avatars, name, role. */}
              <div className="cr-id">
                <div className="cr-avatars" aria-hidden="true">
                  <div className="cr-avatar" data-kind="roblox" title="Roblox Profile">
                    {robloxAvatars[contributor.name] &&
                    !failedRobloxAvatars.has(contributor.name) ? (
                      <img
                        src={robloxAvatars[contributor.name]}
                        alt={`${contributor.name} Roblox`}
                        className="cr-avatar__img"
                        loading="lazy"
                        onError={() =>
                          setFailedRobloxAvatars((previous) =>
                            new Set(previous).add(contributor.name),
                          )
                        }
                      />
                    ) : (
                      <span className="cr-avatar__fallback">{contributor.avatar}</span>
                    )}
                  </div>
                  <div className="cr-avatar" data-kind="discord" title="Discord Profile">
                    {contributor.discordId
                      && DISCORD_AVATARS_BY_ID[contributor.discordId]
                      && !failedDiscordAvatars.has(contributor.discordId) ? (
                      <img
                        src={DISCORD_AVATARS_BY_ID[contributor.discordId]}
                        alt={`${contributor.name} Discord`}
                        className="cr-avatar__img"
                        loading="lazy"
                        onError={() => {
                          const id = contributor.discordId;
                          if (!id) return;
                          setFailedDiscordAvatars((previous) => new Set(previous).add(id));
                        }}
                      />
                    ) : (
                      <span className="cr-avatar__fallback">D</span>
                    )}
                  </div>
                </div>

                <div className="cr-id__text">
                  <h2 className="cr-name">{contributor.name}</h2>
                  <span className="rk-chip" data-tone="accent">
                    {t(contributor.role)}
                  </span>
                </div>
              </div>

              {/* External links, one per row, brand glyph in the status gutter. */}
              <div className="cr-links">
                {contributor.links.map((link) => (
                  <a
                    key={link.url}
                    className="rk-row cr-link"
                    href={link.url}
                    title={link.title}
                    rel="noopener noreferrer"
                    onClick={(event) => handleLinkClick(event, link.url)}
                  >
                    <span className="rk-row__gutter">
                      <svg
                        className="cr-link__glyph"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path d={LINK_ICON_PATHS[link.icon]} />
                      </svg>
                    </span>
                    <span className="rk-row__main">
                      <span className="rk-row__title">{link.label}</span>
                      <span className="rk-row__meta">{link.url}</span>
                    </span>
                    <ExternalLink className="cr-link__ext" size={13} aria-hidden="true" />
                  </a>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

export default CreditsPage;
