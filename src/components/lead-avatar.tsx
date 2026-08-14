import { initialsOf } from "@/lib/initials";

/**
 * A lead's photo, or their initials.
 *
 * The image is served through the authenticated file route — never hotlinked
 * from the source CDN, which would expire and would leak every card view. A
 * broken or missing file degrades to the initials rather than an empty box,
 * so this is safe to render whether or not a capture ever found a photo.
 */
export function LeadAvatar({
  name,
  path,
  size = 40,
}: {
  name: string | null | undefined;
  path: string | null | undefined;
  size?: number;
}) {
  const px = `${size}px`;

  if (path) {
    return (
      // Served from an authenticated route, not an optimisable static asset —
      // next/image would proxy a private file through the optimiser.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/api/files/${path}`}
        alt=""
        width={size}
        height={size}
        data-testid="lead-avatar"
        className="shrink-0 rounded-full border border-line object-cover"
        style={{ width: px, height: px }}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      data-testid="lead-avatar-initials"
      className="grid shrink-0 place-items-center rounded-full border border-line bg-panel-2 font-semibold text-muted"
      style={{ width: px, height: px, fontSize: `${Math.round(size * 0.34)}px` }}
    >
      {initialsOf(name)}
    </span>
  );
}
