/**
 * Alerts domain handler
 *
 * Provides tools for alert operations in ConnectWise Automate.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AlertListParams } from "@wyre-technology/node-connectwise-automate";
import type { DomainHandler, CallToolResult } from "../utils/types.js";
import { getClient, type CWAutomateCredentials } from "../utils/client.js";
import { elicitSelection } from "../utils/elicitation.js";
import { toPage } from "../utils/pagination.js";
import { jsonResult, listResult } from "../utils/results.js";

type AlertStatusFilter = "new" | "acknowledged" | "closed" | "all";

/**
 * Map the friendly status filter to the library's status value.
 * Returns undefined for "all" (or unset), which removes the status filter.
 */
function toAlertStatus(
  status?: AlertStatusFilter
): AlertListParams["status"] | undefined {
  switch (status) {
    case "new":
      return "New";
    case "acknowledged":
      return "Acknowledged";
    case "closed":
      return "Closed";
    default:
      return undefined;
  }
}

/**
 * Get alert domain tools
 */
function getTools(): Tool[] {
  return [
    {
      name: "cwautomate_alerts_list",
      description:
        "List alerts in ConnectWise Automate with optional filtering.",
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
          status: {
            type: "string",
            enum: ["new", "acknowledged", "closed", "all"],
            description: "Filter by alert status (default: all)",
          },
          severity: {
            type: "number",
            description: "Filter by alert severity level (1-5)",
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
      description: "Get details for a specific alert by ID",
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
    {
      name: "cwautomate_alerts_acknowledge",
      description: "Acknowledge an alert to mark it as reviewed",
      inputSchema: {
        type: "object" as const,
        properties: {
          alert_id: {
            type: "number",
            description: "The alert ID to acknowledge",
          },
          comment: {
            type: "string",
            description: "Optional comment to add when acknowledging",
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
      const clientId = args.client_id as number | undefined;
      let status = args.status as AlertStatusFilter | undefined;

      // If no filters provided, ask the user if they want to filter by status
      if (!computerId && !clientId && !status && severity === undefined) {
        const selected = await elicitSelection(
          "Listing all alerts can return many results. Would you like to filter by status?",
          "status",
          [
            { value: "all", label: "All statuses" },
            { value: "new", label: "New only" },
            { value: "acknowledged", label: "Acknowledged only" },
            { value: "closed", label: "Closed only" },
          ]
        );
        if (selected) {
          status = selected as AlertStatusFilter;
        }
      }

      const response = await client.alerts.list({
        computerId,
        clientId,
        status: toAlertStatus(status),
        severity,
        pageSize: limit,
        page: toPage(skip, limit),
      });

      return listResult("alerts", response);
    }

    case "cwautomate_alerts_get": {
      const alertId = args.alert_id as number;
      const alert = await client.alerts.get(alertId);

      return jsonResult(alert);
    }

    case "cwautomate_alerts_acknowledge": {
      const alertId = args.alert_id as number;
      const comment = args.comment as string | undefined;
      const result = await client.alerts.acknowledge({
        AlertIds: [alertId],
        Notes: comment,
      });

      return jsonResult({
        success: true,
        message: `Alert ${alertId} acknowledged`,
        result,
      });
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
