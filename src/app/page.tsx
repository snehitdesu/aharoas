import { redirect } from "next/navigation";

/** The operator app starts at the dashboard (which sends unauthenticated users to /login). */
export default function HomePage() {
  redirect("/dashboard");
}
