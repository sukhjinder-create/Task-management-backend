/**
 * Test Strategic Intelligence Query
 *
 * This script demonstrates the correct JSON format for the intelligence query endpoint
 */

import axios from "axios";

const BASE_URL = process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 5000}`;

// Replace with your actual JWT token
const TOKEN = "YOUR_JWT_TOKEN_HERE";

async function testIntelligenceQuery() {
  try {
    console.log("Testing Strategic Intelligence Query...\n");

    // Example 1: Workspace-level query
    const workspaceQuery = {
      scope: "workspace",
      question: "What are the operational risks this month?"
    };

    console.log("Request 1 - Workspace Query:");
    console.log(JSON.stringify(workspaceQuery, null, 2));
    console.log("");

    const response1 = await axios.post(
      `${BASE_URL}/ai/intelligence-query`,
      workspaceQuery,
      {
        headers: {
          "Authorization": `Bearer ${TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("Response 1:");
    console.log(response1.data);
    console.log("\n---\n");

    // Example 2: Project-level query
    const projectQuery = {
      scope: "project",
      entityId: "your-project-uuid-here",
      question: "Why is this project delayed?"
    };

    console.log("Request 2 - Project Query:");
    console.log(JSON.stringify(projectQuery, null, 2));
    console.log("");

    // Example 3: Task-level query
    const taskQuery = {
      scope: "task",
      entityId: "your-task-uuid-here",
      question: "Summarize the history of this task"
    };

    console.log("Request 3 - Task Query:");
    console.log(JSON.stringify(taskQuery, null, 2));
    console.log("");

  } catch (error) {
    console.error("Error:", error.response?.data || error.message);
  }
}

// Run test
testIntelligenceQuery();
