/** Input data for cloning an existing project into a new, independently owned copy. */
export interface CloneProjectDto {
  /** Human-readable name for the copy; the source project's name is never reused implicitly. */
  name: string;
}
