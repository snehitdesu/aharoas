import { MockPOSProvider } from "./mock";
import { PetpoojaPOSProvider } from "./petpooja";
import type { POSProvider } from "./types";
import { assertMockAllowed, unknownProvider } from "@/integrations/policy";

export function getPOSProvider(name?: string): POSProvider {
  const provider = (name ?? process.env.POS_PROVIDER ?? "mock").toLowerCase();
  switch (provider) {
    case "petpooja":
      return new PetpoojaPOSProvider();
    case "mock":
      assertMockAllowed("POS");
      return new MockPOSProvider();
    default:
      return unknownProvider("POS", provider);
  }
}

export { MockPOSProvider } from "./mock";
export { PetpoojaPOSProvider } from "./petpooja";
export type { POSProvider, NormalizedOrder, NormalizedOrderItem } from "./types";
