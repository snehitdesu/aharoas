// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Field, Input, Select, Textarea, Checkbox } from "@/components/ui/Form";

afterEach(cleanup);

describe("form control id/name", () => {
  it("binds Field children to a stable id and name from the field name", () => {
    render(
      <Field label="Outlet price" name="price" required>
        <Input type="number" />
      </Field>
    );
    const el = screen.getByLabelText(/Outlet price/) as HTMLInputElement;
    expect(el.id).toBe("price");
    expect(el.name).toBe("price");
    expect(el.getAttribute("aria-required")).toBe("true");
  });

  it("does not overwrite an explicit id already on the control", () => {
    render(
      <Field label="Notes" name="notes">
        <Textarea id="order-notes" />
      </Field>
    );
    const el = screen.getByLabelText("Notes") as HTMLTextAreaElement;
    expect(el.id).toBe("order-notes");
    expect(el.name).toBe("notes");
  });

  it("does not bind htmlFor onto composite children so wrapping-label association still works", () => {
    function VendorSelect() {
      return (
        <select>
          <option value="v1">Karachi Bakery Supplies</option>
        </select>
      );
    }
    render(
      <Field label="Vendor" name="vendorId">
        <VendorSelect />
      </Field>
    );
    const el = screen.getByLabelText(/^Vendor/) as HTMLSelectElement;
    expect(el.tagName).toBe("SELECT");
    expect(el.id).toBe("");
    const field = el.closest("label");
    expect(field).not.toBeNull();
    expect(field!.htmlFor).toBe("");
  });

  it("gives Select and Checkbox both id and name", () => {
    render(
      <>
        <Field label="Status" name="status">
          <Select>
            <option value="OPEN">Open</option>
          </Select>
        </Field>
        <Checkbox name="offered" label="Offered here" checked onChange={() => undefined} />
      </>
    );
    const select = screen.getByLabelText("Status") as HTMLSelectElement;
    expect(select.id).toBe("status");
    expect(select.name).toBe("status");
    const box = screen.getByLabelText("Offered here") as HTMLInputElement;
    expect(box.id).toBe("offered");
    expect(box.name).toBe("offered");
  });
});
