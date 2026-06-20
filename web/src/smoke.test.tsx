import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

describe("toolchain", () => {
  it("renders", () => {
    render(<div>tweaklet ok</div>);
    expect(screen.getByText("tweaklet ok")).toBeInTheDocument();
  });
});
