import { FlatList, RefreshControl } from 'react-native';
import { api } from '../../../lib/api';
import { useLoad } from '../../../lib/useLoad';
import { colors } from '../../../constants/colors';
import { ContractCard } from '../../../components/ContractCard';
import { EmptyState, ErrorBanner, Loading } from '../../../components/ui';

/** Every contract, newest first, each with its own Pay button when anything can be paid. */
export default function ContractsList() {
  const { data, error, refreshing, reload } = useLoad(api.contracts);
  if (!data && !error) return <Loading />;
  return (
    <FlatList
      data={data ?? []}
      keyExtractor={(c) => c.id}
      renderItem={({ item }) => <ContractCard contract={item} />}
      contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
      ListHeaderComponent={error ? <ErrorBanner message={error} onRetry={reload} /> : undefined}
      ListEmptyComponent={error ? undefined : <EmptyState icon="document-text-outline" title="No contracts found" />}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} colors={[colors.primary]} />}
    />
  );
}
