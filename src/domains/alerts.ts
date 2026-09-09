/**
 * Alerts domain handler
 *
 * Provides tools for alert operations in ConnectWise Automate.
 *
 * Alerts are read-only in the Automate API: the published spec exposes only
 * GET /Alerts, GET /Alerts/{id} and GET /Computers/{id}/Alerts. There is no
 * status field and no acknowledge/close route, so this domain offers list
 * and get only. Filtering goes through the generic `condition` expression;
 * Automate silently ignores any other query parameter.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { DomainHandler, CallToolResult } from "../utils/types.js";
import { getClient, type CWAutomateCredentials } from "../utils/client.js";
import { elicitText } from "../utils/elicitation.js";
import { toPage } from "../utils/pagination.js";
import { jsonResult, listResult } from "../utils/results.js";
import { andConditions, equalsCondition } from "../utils/odata.js";

/**
 * Get alert domain tools
 */
function getTools(): Tool[] {
  return [
    {
      name: "cwautomate_alerts_list",
      description:
        "List alerts in ConnectWise Automate with optional filtering by " +
        "computer, client or severity. Alerts are read-only in the Automate " +
        "API: they carry no status and cannot be acknowledged or closed " +
        "through it.",
      inputSchema: {
        type: "object" as const,
        properties: {
          computer_id: {
            type: "number",
            description: "Filter alerts by computer ID",
          },
          client_id: {
            type: "number",
            description: "Filter alerts by client ID",
          },
          severity: {
            type: "number",
            description:
              "Filter by severity ID (matches the alert's Severity.Id)",
          },
          limit: {
            type: "number",
            description: "Maximum number of results per page (default: 50)",
          },
          skip: {
            type: "number",
            description: "Number of results to skip for pagination",
          },
        },
      },
    },
    {
      name: "cwautomate_alerts_get",
      description:
        "Get details for a specific alert by ID. Alerts are read-only in " +
        "the Automate API.",
      inputSchema: {
        type: "object" as const,
        properties: {
          alert_id: {
            type: "number",
            description: "The alert ID",
          },
        },
        required: ["alert_id"],
      },
    },
  ];
}

/**
 * Handle an alert domain tool call
 */
async function handleCall(
  toolName: string,
  args: Record<string, unknown>,
  creds?: CWAutomateCredentials
): Promise<CallToolResult> {
  const client = await getClient(creds);

  switch (toolName) {
    case "cwautomate_alerts_list": {
      const limit = (args.limit as number) || 50;
      const skip = (args.skip as number) || 0;
      const severity = args.severity as number | undefined;
      const computerId = args.computer_id as number | undefined;
      let clientId = args.client_id as number | undefined;

      // If no filters provided, ask the user if they want to narrow by client
      if (!computerId && !clientId && severity === undefined) {
        const filterValue = await elicitText(
          "Listing all alerts can return a large result set. Would you like to filter by a client ID? Leave blank to list all.",
          "client_id",
          "Enter a client ID to filter by, or leave blank for all alerts"
        );
        if (filterValue && !isNaN(Number(filterValue))) {
          clientId = Number(filterValue);
        }
      }

      const params = {
        condition: andConditions(
          equalsCondition("Client.Id", clientId),
          equalsCondition("Severity.Id", severity)
        ),
        pageSize: limit,
        page: toPage(skip, limit),
      };

      // A computer has its own alerts route; everything else is a condition
      // on the global list.
      const response =
        computerId !== undefined
          ? await client.alerts.listForComputer(computerId, params)
          : await client.alerts.list(params);

      return listResult("alerts", response);
    }

    case "cwautomate_alerts_get": {
      const alertId = args.alert_id as number;
      const alert = await client.alerts.get(alertId);

      return jsonResult(alert);
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown alert tool: ${toolName}` }],
        isError: true,
      };
  }
}

export const alertsHandler: DomainHandler = {
  getTools,
  handleCall,
};
