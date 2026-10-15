# Documentation diagrams

Each diagram has an editable `.excalidraw` source and an SVG preview. The previews are embedded in the [main README](../../README.md), [user guide](../user-guide.md), and [architecture guide](../architecture.md). The table below links to the files; it does not embed the images again.

| Diagram | What it explains | Source | Preview |
| --- | --- | --- | --- |
| Workflow | Local setup, deployment, and inspection | [Edit](workflow.excalidraw) | [View](workflow.svg) |
| Architecture | Local CLI, deployed app, model provider, and shared Redis conversation history | [Edit](architecture.excalidraw) | [View](architecture.svg) |
| Deployment | Runtime secrets, provider authentication, and filtered source upload | [Edit](deployment.excalidraw) | [View](deployment.svg) |

## Edit a diagram

1. Download the `.excalidraw` file and open it in [Excalidraw](https://excalidraw.com) using **Open**, or drag it onto the canvas.
2. Edit the shapes and labels. Save the updated scene to the same `.excalidraw` filename.
3. Export an SVG with a white background and no dark mode, and replace the matching `.svg` preview. The initial previews were generated from the scene primitives; future previews can be exported directly from Excalidraw.
4. Review the image in the Markdown page. Keep the surrounding text and image description consistent with the diagram.

Use placeholders, never real credentials. These diagrams explain the intended flows; they do not prove that a live cloud deployment has been verified.
