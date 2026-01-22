// Cloudflare Worker - boothiq-gemini
// Routes Gemini API calls through secure proxy with SKILL.md system prompt

const SKILL_URL = 'https://raw.githubusercontent.com/blue-sky-flyer/boothiq1/main/skills/quote-generator/SKILL.md';
const CATALOG_URL = 'https://raw.githubusercontent.com/blue-sky-flyer/boothiq1/main/MASTER_CATALOG.md';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// Structured output schema for booth quotes
const QUOTE_SCHEMA = {
  type: "object",
  properties: {
    project_type: {
      type: "string",
      enum: ["toronto_standard", "toronto_festival", "outoftown", "fabrication_only"],
      description: "Detected project profile"
    },
    materials: {
      type: "object",
      properties: {
        walls: { type: "number", description: "Wall fabrication cost" },
        flooring: { type: "number", description: "Flooring cost" },
        graphics: { type: "number", description: "Graphics/signage cost" },
        av_lighting: { type: "number", description: "AV and lighting cost" },
        furniture: { type: "number", description: "Furniture rental cost" },
        other: { type: "number", description: "Other materials" },
        subtotal: { type: "number", description: "Materials subtotal" }
      },
      required: ["subtotal"]
    },
    services: {
      type: "object",
      properties: {
        design_pm: { type: "number", description: "Design and project management" },
        design_pm_percent: { type: "number", description: "Design/PM as % of materials" },
        install_dismantle: { type: "number", description: "Installation and dismantling labor" },
        install_dismantle_percent: { type: "number", description: "I&D as % of materials" },
        logistics: { type: "number", description: "Shipping and drayage" },
        logistics_percent: { type: "number", description: "Logistics as % of materials" },
        subtotal: { type: "number", description: "Services subtotal" }
      },
      required: ["subtotal"]
    },
    contingency: { type: "number", description: "Contingency amount (5-10%)" },
    subtotal_before_tax: { type: "number", description: "Subtotal before tax" },
    tax_rate: { type: "number", description: "Tax rate (e.g., 0.13 for HST, 0.14975 for QST+GST)" },
    tax_amount: { type: "number", description: "Calculated tax amount" },
    total: { type: "number", description: "Final total including tax" },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
      description: "Confidence level in the estimate"
    },
    notes: {
      type: "array",
      items: { type: "string" },
      description: "Important notes, assumptions, or caveats"
    }
  },
  required: ["project_type", "materials", "services", "subtotal_before_tax", "tax_rate", "tax_amount", "total", "confidence"]
};

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    try {
      // Fetch SKILL.md and MASTER_CATALOG at runtime
      const [skillRes, catalogRes] = await Promise.all([
        fetch(SKILL_URL),
        fetch(CATALOG_URL)
      ]);

      if (!skillRes.ok || !catalogRes.ok) {
        throw new Error('Failed to fetch skill or catalog from GitHub');
      }

      const skillContent = await skillRes.text();
      const catalogContent = await catalogRes.text();

      const systemInstruction = `${skillContent}\n\n---\n\n# REFERENCE DATA\n${catalogContent}`;

      const body = await request.json();

      // Build Gemini request with structured output
      const geminiRequest = {
        contents: body.messages.map(msg => ({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }]
        })),
        systemInstruction: {
          parts: [{ text: systemInstruction }]
        },
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: QUOTE_SCHEMA,
          temperature: 0.1,
          maxOutputTokens: 4096
        }
      };

      // Call Gemini API
      const model = body.model || 'gemini-2.5-flash';
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GOOGLE_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(geminiRequest)
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
      }

      const geminiResponse = await response.json();

      // Extract the text from Gemini's response structure
      const textContent = geminiResponse.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!textContent) {
        throw new Error('No content in Gemini response');
      }

      // Parse and return the structured JSON
      const quote = JSON.parse(textContent);

      return new Response(JSON.stringify({
        quote,
        model,
        usage: geminiResponse.usageMetadata
      }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });

    } catch (error) {
      return new Response(JSON.stringify({
        error: error.message,
        type: 'worker_error'
      }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }
  }
};
