import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export const summarizeConversation = async (messages: string[]) => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Summarize the following conversation in a concise way:\n\n${messages.join('\n')}`,
      config: {
        systemInstruction: "You are a helpful assistant that summarizes chat conversations. Keep it brief and highlight key points.",
      },
    });
    return response.text;
  } catch (error) {
    console.error("Gemini summarization error:", error);
    return "Failed to summarize conversation.";
  }
};

export const askAI = async (prompt: string, context?: string) => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: context ? `Context:\n${context}\n\nQuestion: ${prompt}` : prompt,
      config: {
        systemInstruction: "You are an intelligent assistant integrated into Cyberse Link, a modern chat platform. Be helpful, friendly, and concise.",
      },
    });
    return response.text;
  } catch (error) {
    console.error("Gemini AI error:", error);
    return "I'm sorry, I encountered an error while processing your request.";
  }
};
