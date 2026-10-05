import Image from "next/image";
import { SCREENS, type ScreenName } from "@/site/screens";

/**
 * A real RESTORA screen (captured from the running application with sample
 * data by scripts/site/capture-screens.mjs), in a quiet window or phone frame.
 */
export function Screen({
  name,
  sizes = "(min-width: 1280px) 1200px, 100vw",
  priority = false,
  className = "",
  title,
}: {
  name: ScreenName;
  sizes?: string;
  priority?: boolean;
  className?: string;
  /** Window title; defaults to the screen's own title. */
  title?: string;
}) {
  const s = SCREENS[name];
  // Frames are positioned relative unless the caller places them (absolute / sticky).
  const pos = /(^|\s)(absolute|fixed|sticky)(\s|$)/.test(className) ? "" : "relative";
  if (s.device === "phone") {
    return (
      <div className={`s-phone ${pos} ${className}`}>
        <div>
          <Image src={s.src} alt={s.alt} width={s.w} height={s.h} sizes={sizes} priority={priority} />
        </div>
      </div>
    );
  }
  return (
    <div className={`s-window ${pos} ${className}`}>
      <div className="s-window-bar" aria-hidden>
        <i />
        <i />
        <i />
        <span>{title ?? s.title}</span>
      </div>
      <Image src={s.src} alt={s.alt} width={s.w} height={s.h} sizes={sizes} priority={priority} />
    </div>
  );
}
