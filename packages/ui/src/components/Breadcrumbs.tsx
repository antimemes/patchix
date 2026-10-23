import { Link } from "./Link.tsx";
import "./Breadcrumbs.css";

export interface Crumb {
  label: string;
  href?: string | undefined;
}

export function Breadcrumbs({ items }: { items: readonly Crumb[] }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label="Breadcrumbs" className="ui-crumbs">
      <ol>
        {items.map((item, i) => (
          <li key={`${i}:${item.label}`}>
            {item.href === undefined ? <span aria-current="page">{item.label}</span> : <Link href={item.href}>{item.label}</Link>}
          </li>
        ))}
      </ol>
    </nav>
  );
}
