import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function LegacyOverwatchCasePage({ params }: { params: { caseId: string } }) {
  redirect(`/overwatch/case/${params.caseId}`);
}
