"use client";

import { useParams } from "next/navigation";
import ProviderManager from "./ProviderManager";

export default function ProviderDetailPage() {
  const { id } = useParams();
  return <ProviderManager providerId={id} />;
}
