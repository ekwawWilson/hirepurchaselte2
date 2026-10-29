import { Redirect } from 'expo-router';

/** The centre tab only ever opens Pay (see (tabs)/_layout.tsx); reached any other way, it goes there too. */
export default function PayTab() {
  return <Redirect href="/pay" />;
}
