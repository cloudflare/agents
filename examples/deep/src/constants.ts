export const CF_GQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
export const CF_ZONE_ENDPOINT = "https://api.cloudflare.com/client/v4/zones/";

// TopN GraphQL Query
export const GET_CUSTOM_TOPN_TEMPLATE = `
query GetCustomTopN($zoneTag: string, $filter: httpRequestsAdaptiveGroupsFilter_InputObject, $limit: int) {
  viewer {
    scope: zones(filter: {zoneTag: $zoneTag}) {
      total: httpRequestsAdaptiveGroups(filter: $filter, limit: 1) { count __typename }
      topN: httpRequestsAdaptiveGroups(filter: $filter, limit: $limit, orderBy: [count_DESC]) {
        count
        dimensions { metric: DIMENSION_PLACEHOLDER __typename }
        __typename
      }
      __typename
    }
    __typename
  }
}
`;

// Stat GraphQL Query
export const GET_CUSTOM_STAT = `
query GetCustomStat($zoneTag: string, $filter: httpRequestsAdaptiveGroupsFilter_InputObject, $prevFilter: httpRequestsAdaptiveGroupsFilter_InputObject) {
  viewer {
    scope: zones(filter: {zoneTag: $zoneTag}) {
      total: httpRequestsAdaptiveGroups(filter: $filter, limit: 1) { count __typename }
      previously: httpRequestsAdaptiveGroups(filter: $prevFilter, limit: 1) { count __typename }
      sparkline: httpRequestsAdaptiveGroups(filter: $filter, limit: 5000, orderBy: [datetimeHour_ASC]) {
        count
        dimensions { ts: datetimeHour __typename }
        __typename
      }
      __typename
    }
    __typename
  }
}
`;
