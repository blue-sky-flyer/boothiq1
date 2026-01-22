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
      const model = body.model || 'gemini-2.5-flash';
      const isGemini3 = model.startsWith('gemini-3');

      // For Gemini 3, don't use structured output (causes precision bugs)
      // Instead, ask for JSON in the user message
      let messages = body.messages;
      if (isGemini3) {
        // Append JSON format instructions to the last user message
        const lastMsgIndex = messages.length - 1;
        const jsonInstructions = `\n\nIMPORTANT: Return ONLY a valid JSON object with these exact fields:
{
  "project_type": "toronto_standard" | "toronto_festival" | "outoftown" | "fabrication_only",
  "materials": { "walls": number, "flooring": number, "graphics": number, "av_lighting": number, "furniture": number, "other": number, "subtotal": number },
  "services": { "design_pm": number, "design_pm_percent": number, "install_dismantle": number, "install_dismantle_percent": number, "logistics": number, "logistics_percent": number, "subtotal": number },
  "contingency": number,
  "subtotal_before_tax": number,
  "tax_rate": number,
  "tax_amount": number,
  "total": number,
  "confidence": "high" | "medium" | "low",
  "notes": ["string", ...]
}
Use whole numbers for dollar amounts. No markdown, no explanation, just the JSON.`;
        messages = messages.map((msg, i) =>
          i === lastMsgIndex ? { ...msg, content: msg.content + jsonInstructions } : msg
        );
      }

      const geminiRequest = {
        contents: messages.map(msg => ({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }]
        })),
        systemInstruction: {
          parts: [{ text: systemInstruction }]
        },
        generationConfig: {
          // Only use structured output for non-Gemini-3 models
          ...(isGemini3 ? {} : { responseMimeType: 'application/json', responseSchema: QUOTE_SCHEMA }),
          temperature: 0.1,
          maxOutputTokens: 4096,
          ...(isGemini3 && { thinkingConfig: { thinkingLevel: 'LOW' } })
        }
      };

      // Call Gemini API
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

      // Try to clean and parse the JSON - Gemini 3 sometimes includes extra content
      let cleanedText = textContent.trim();

      // Remove any markdown code fences if present
      if (cleanedText.startsWith('```json')) {
        cleanedText = cleanedText.slice(7);
      } else if (cleanedText.startsWith('```')) {
        cleanedText = cleanedText.slice(3);
      }
      if (cleanedText.endsWith('```')) {
        cleanedText = cleanedText.slice(0, -3);
      }
      cleanedText = cleanedText.trim();

      // Find the JSON object boundaries
      const jsonStart = cleanedText.indexOf('{');
      const jsonEnd = cleanedText.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        cleanedText = cleanedText.slice(jsonStart, jsonEnd + 1);
      }

      // Parse the structured JSON
      const quote = JSON.parse(cleanedText);

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
