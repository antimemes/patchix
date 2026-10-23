import { Link } from "../components/Link.tsx";
import { href } from "../router.ts";

export function NotFound({ path }: { path: string }) {
  return (
    <section className="stack">
      <h1>No such page</h1>
      <p className="muted">
        patchix has no page at <code>{path}</code>.
      </p>
      <p>
        <Link href={href.home()}>Go to the campaigns</Link>
      </p>
    </section>
  );
}
