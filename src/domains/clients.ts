/**
 * Clients domain handler
 *
 * Provides tools for client operations in ConnectWise Automate.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { DomainHandler, CallToolResult } from "../utils/types.js";
import { getClient, type CWAutomateCredentials } from "../utils/client.js";
import { toPage } from "../utils/pagination.js";
import { jsonResult, listResult, listItems } from "../utils/results.js";

/**
 * Get client domain tools
 */
function getTools(): Tool[] {
  return [
    {
      name: "cwautomate_clients_list",
      description:
        "List all clients in ConnectWise Automate with optional filtering.",
      inputSchema: {
        type: "object" as const,
        properties: {
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
      name: "cwautomate_clients_get",
      description: "Get details for a specific client by ID",
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: {
            type: "number",
            description: "The client ID",
          },
          include_locations: {
            type: "boolean",
            description: "Include location details in the response",
          },
        },
        required: ["client_id"],
      },
    },
    {
      name: "cwautomate_clients_create",
      description: "Create a new client in ConnectWise Automate",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "Client name",
          },
          city: {
            type: "string",
            description: "City",
          },
          state: {
            type: "string",
            description: "State/Province",
          },
          zip: {
            type: "string",
            description: "ZIP/Postal code",
          },
          country: {
            type: "string",
            description: "Country",
          },
          phone: {
            type: "string",
            description: "Phone number",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "cwautomate_clients_update",
      description: "Update an existing client in ConnectWise Automate",
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: {
            type: "number",
            description: "The client ID to update",
          },
          name: {
            type: "string",
            description: "New client name",
          },
          city: {
            type: "string",
            description: "New city",
          },
          state: {
            type: "string",
            description: "New state/province",
          },
          zip: {
            type: "string",
            description: "New ZIP/postal code",
          },
          country: {
            type: "string",
            description: "New country",
          },
          phone: {
            type: "string",
            description: "New phone number",
          },
        },
        required: ["client_id"],
      },
    },
  ];
}

/**
 * Handle a client domain tool call
 */
async function handleCall(
  toolName: string,
  args: Record<string, unknown>,
  creds?: CWAutomateCredentials
): Promise<CallToolResult> {
  const client = await getClient(creds);

  switch (toolName) {
    case "cwautomate_clients_list": {
      const limit = (args.limit as number) || 50;
      const skip = (args.skip as number) || 0;
      const response = await client.clients.list({
        pageSize: limit,
        page: toPage(skip, limit),
      });

      return listResult("clients", response);
    }

    case "cwautomate_clients_get": {
      const clientId = args.client_id as number;
      const includeLocations = args.include_locations as boolean | undefined;

      if (includeLocations) {
        // The client and its locations are independent reads — fetch concurrently.
        const [clientData, locationsResponse] = await Promise.all([
          client.clients.get(clientId),
          client.locations.list({ clientId }),
        ]);
        return jsonResult({
          ...clientData,
          locations: listItems(locationsResponse),
        });
      }

      const clientData = await client.clients.get(clientId);
      return jsonResult(clientData);
    }

    case "cwautomate_clients_create": {
      const newClient = await client.clients.create({
        Name: args.name as string,
        City: args.city as string | undefined,
        State: args.state as string | undefined,
        ZipCode: args.zip as string | undefined,
        Country: args.country as string | undefined,
        PhoneNumber: args.phone as string | undefined,
      });

      return jsonResult(newClient);
    }

    case "cwautomate_clients_update": {
      const clientId = args.client_id as number;
      const updatedClient = await client.clients.update(clientId, {
        Name: args.name as string | undefined,
        City: args.city as string | undefined,
        State: args.state as string | undefined,
        ZipCode: args.zip as string | undefined,
        Country: args.country as string | undefined,
        PhoneNumber: args.phone as string | undefined,
      });

      return jsonResult(updatedClient);
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown client tool: ${toolName}` }],
        isError: true,
      };
  }
}

export const clientsHandler: DomainHandler = {
  getTools,
  handleCall,
};
