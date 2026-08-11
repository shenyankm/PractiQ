import { Platform } from 'react-native';
import Purchases, { LOG_LEVEL, type CustomerInfo, type CustomerInfoUpdateListener } from 'react-native-purchases';
import RevenueCatUI from 'react-native-purchases-ui';

export const REVENUECAT_ENTITLEMENT_ID =
  process.env.EXPO_PUBLIC_REVENUECAT_ENTITLEMENT_ID?.trim() || 'pro';

let identifiedUser = '';

function apiKey() {
  const key = Platform.OS === 'ios'
    ? process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY
    : process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY;
  if (!key?.trim()) throw new Error('RevenueCat is not configured for this platform.');
  return key.trim();
}

export function customerHasPro(info: CustomerInfo | null) {
  return Boolean(info?.entitlements.active[REVENUECAT_ENTITLEMENT_ID]);
}

export async function identifyRevenueCat(appUserID: string) {
  if (!(await Purchases.isConfigured())) {
    Purchases.configure({ apiKey: apiKey(), appUserID });
    if (__DEV__) await Purchases.setLogLevel(LOG_LEVEL.DEBUG);
  } else if (identifiedUser !== appUserID) {
    await Purchases.logIn(appUserID);
  }
  identifiedUser = appUserID;
  return Purchases.getCustomerInfo();
}

export function listenForCustomerInfo(listener: CustomerInfoUpdateListener) {
  Purchases.addCustomerInfoUpdateListener(listener);
  return () => Purchases.removeCustomerInfoUpdateListener(listener);
}

export async function presentProPaywall() {
  await RevenueCatUI.presentPaywallIfNeeded({
    requiredEntitlementIdentifier: REVENUECAT_ENTITLEMENT_ID,
  });
  return Purchases.getCustomerInfo();
}

export function restoreRevenueCatPurchases() {
  return Purchases.restorePurchases();
}

export function presentRevenueCatCustomerCenter() {
  return RevenueCatUI.presentCustomerCenter();
}
