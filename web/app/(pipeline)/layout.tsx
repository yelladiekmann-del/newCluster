import { PipelineSessionGuard } from "@/components/pipeline/PipelineSessionGuard";

export default function PipelineLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <PipelineSessionGuard>{children}</PipelineSessionGuard>;
}
