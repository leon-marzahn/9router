import { CustomerView } from "@/ui/customer/CustomerView";

export const metadata = {
  title: "Your usage · Elizabeth's Proxy",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

/** Customer view: a key holder's own usage. Outside the dashboard frame; no session needed. */
export default function CustomerPage() {
  return <CustomerView />;
}
