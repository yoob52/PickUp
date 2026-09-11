import type { PickupAPI } from "../../shared/contracts";
declare global {
  interface Window {
    pickup: PickupAPI;
  }
}
