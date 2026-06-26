import { redirect } from "next/navigation";

// Authenticated users land on the dashboard; the middleware bounces
// unauthenticated requests for /dashboard to /login.
export default function Home() {
  redirect("/dashboard");
}
