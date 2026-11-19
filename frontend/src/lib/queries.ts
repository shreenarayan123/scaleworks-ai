import { queryOptions } from '@tanstack/react-query';
import { api, type CallsPageParams } from './api';
export const callsQuery = (params: CallsPageParams = {}) => queryOptions({ queryKey: ['calls', params], queryFn: () => api.getCalls(params) });
export const callStatsQuery = () => queryOptions({ queryKey: ['call-stats'], queryFn: api.getCallStats });
export const callQuery = (id: string) => queryOptions({ queryKey: ['call', id], queryFn: () => api.getCall(id) });
export const settingsQuery = () => queryOptions({ queryKey: ['settings'], queryFn: api.getSettings });
